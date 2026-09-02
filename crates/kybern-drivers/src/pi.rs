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
use crate::{AgentDriver, AgentSession, DriverError, DriverEvent, Result, SessionConfig, SpawnedSession};

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
}

#[async_trait]
impl AgentDriver for PiDriver {
    fn kind(&self) -> ProviderKind {
        Self::kind_of(self.flavor)
    }

    async fn probe(&self, binary: Option<&PathBuf>) -> ProviderStatus {
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
            instances: vec!["default".into()],
        };
        let bin = match resolve(kind, binary) {
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
            }
            None => status.unavailable_reason = Some(format!("could not run `{} --version`", kind.default_binary())),
        }
        status
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
        }

        // Rewind: fork the persisted session at the first dropped user message.
        if config.fork {
            if let Some(entry) = config.rewind.as_ref().and_then(|r| r.drop_from.turn_id.clone()) {
                let cmd_name = match self.flavor {
                    Flavor::Pi => "fork",
                    Flavor::Omp => "branch",
                };
                session.call(cmd_name, json!({ "entryId": entry })).await?;
            }
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

    async fn handle_frame(&self, v: Value) {
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
                            self.emit(DriverEvent::TextDelta { message_id, delta: d.to_string() }).await;
                        }
                    }
                    Some("thinking_delta") => {
                        if let Some(d) = ev.get("delta").and_then(|d| d.as_str()) {
                            self.state.lock().await.current_thinking.push_str(d);
                            self.emit(DriverEvent::ThinkingDelta { message_id, delta: d.to_string() }).await;
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
                        text,
                        thinking: if thinking.is_empty() { None } else { Some(thinking) },
                    })
                    .await;
                }
            }
            "tool_execution_start" => {
                self.emit(DriverEvent::ToolStarted(ToolCall {
                    id: v.get("toolCallId").and_then(|i| i.as_str()).unwrap_or("").to_string(),
                    name: v.get("toolName").and_then(|n| n.as_str()).unwrap_or("tool").to_string(),
                    input: v.get("args").cloned().unwrap_or(Value::Null),
                    parent_id: None,
                }))
                .await;
            }
            "tool_execution_end" => {
                let content = v.pointer("/result/content").cloned().unwrap_or(Value::Null);
                self.emit(DriverEvent::ToolCompleted {
                    tool_call_id: v.get("toolCallId").and_then(|i| i.as_str()).unwrap_or("").to_string(),
                    output: json!({ "content": content, "details": v.pointer("/result/details") }),
                    is_error: v.get("isError").and_then(|e| e.as_bool()).unwrap_or(false),
                })
                .await;
            }
            "agent_end" => {
                // pi finishes with `agent_settled`; omp has no such frame and marks the last `agent_end`.
                let terminal = match self.flavor {
                    Flavor::Pi => false,
                    Flavor::Omp => v.get("isTerminal").and_then(|t| t.as_bool()) != Some(false),
                };
                if terminal {
                    self.finish_turn().await;
                }
            }
            "agent_settled" => self.finish_turn().await,
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

    async fn handle_ui_request(&self, v: &Value) {
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
                // Not an approval; cancel so the agent continues without blocking.
                let _ = self.child.write(&json!({ "type": "extension_ui_response", "id": id, "cancelled": true })).await;
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
        let mut params = json!({ "message": message.plain_text() });
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

    async fn respond_permission(&self, request_id: &str, decision: &ApprovalDecision) -> Result<()> {
        if self.0.pending_approvals.lock().await.remove(request_id).is_none() {
            return Err(DriverError::Protocol(format!("no pending approval {request_id}")));
        }
        let value = match decision {
            ApprovalDecision::AllowOnce | ApprovalDecision::AllowAlways => "Approve",
            ApprovalDecision::Deny { .. } => "Deny",
        };
        self.0.child.write(&json!({ "type": "extension_ui_response", "id": request_id, "value": value })).await
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
