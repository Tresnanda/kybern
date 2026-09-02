//! Claude Code driver: speaks the CLI's `stream-json` protocol over stdio.
//!
//! Spawn shape (mirrors what the official Agent SDK does):
//! `claude --output-format stream-json --input-format stream-json --verbose
//!   --include-partial-messages --permission-prompt-tool stdio --session-id <uuid>`
//! The process stays alive across turns; each user message on stdin starts a
//! turn that ends with a `result` frame. Permission prompts arrive as
//! `control_request{subtype:"can_use_tool"}` and are answered on stdin.

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
use crate::{AgentDriver, AgentSession, DriverError, DriverEvent, Result, SessionConfig, SpawnedSession, summarize_tool_call};

const MIN_VERSION: (u64, u64, u64) = (2, 1, 0);

#[derive(Default)]
pub struct ClaudeDriver;

#[async_trait]
impl AgentDriver for ClaudeDriver {
    fn kind(&self) -> ProviderKind {
        ProviderKind::ClaudeCode
    }

    async fn probe(&self, binary: Option<&PathBuf>) -> ProviderStatus {
        let mut status = ProviderStatus {
            kind: ProviderKind::ClaudeCode,
            display_name: ProviderKind::ClaudeCode.display_name().into(),
            available: false,
            binary_path: None,
            version: None,
            unavailable_reason: None,
            supported_permission_modes: PermissionMode::ALL.to_vec(),
            supports_fork: true,
            supports_model_switch: true,
            instances: vec!["default".into()],
        };
        let bin = match resolve(ProviderKind::ClaudeCode, binary) {
            Ok(b) => b,
            Err(e) => {
                status.unavailable_reason = Some(format!("{e}. Install with: npm install -g @anthropic-ai/claude-code"));
                return status;
            }
        };
        status.binary_path = Some(bin.display().to_string());
        match version_of(&bin, &["--version"]).await {
            Some(v) => {
                let ok = at_least(&v, MIN_VERSION);
                status.available = ok;
                if !ok {
                    status.unavailable_reason = Some(format!("Claude Code {v} is older than the required {}.{}.{}", MIN_VERSION.0, MIN_VERSION.1, MIN_VERSION.2));
                }
                status.version = Some(v);
            }
            None => status.unavailable_reason = Some("could not run `claude --version`".into()),
        }
        status
    }

    async fn spawn(&self, config: SessionConfig) -> Result<SpawnedSession> {
        let bin = resolve(ProviderKind::ClaudeCode, config.binary.as_ref())?;
        let session_id = match (&config.resume_session_id, config.fork) {
            (Some(id), false) => id.clone(),
            _ => Uuid::new_v4().to_string(),
        };

        let mut cmd = Command::new(&bin);
        cmd.current_dir(&config.cwd)
            .args(["--output-format", "stream-json", "--input-format", "stream-json", "--verbose", "--include-partial-messages"])
            .args(["--permission-prompt-tool", "stdio"]);
        match (&config.resume_session_id, config.fork) {
            (Some(id), false) => {
                cmd.arg(format!("--resume={id}"));
            }
            (Some(id), true) => {
                cmd.arg(format!("--resume={id}")).arg("--fork-session").arg(format!("--session-id={session_id}"));
                // Rewind: keep the transcript through the last assistant entry of the turn before the cut.
                if let Some(end) = config.rewind.as_ref().and_then(|r| r.keep_through.as_ref()).and_then(|a| a.previous_end.clone()) {
                    cmd.arg(format!("--resume-session-at={end}"));
                }
            }
            (None, _) => {
                cmd.arg(format!("--session-id={session_id}"));
            }
        }
        cmd.args(["--permission-mode", mode_arg(config.permission_mode)]);
        if config.permission_mode == PermissionMode::FullAccess {
            cmd.arg("--allow-dangerously-skip-permissions");
        }
        if let Some(model) = &config.model {
            cmd.args(["--model", model]);
        }
        cmd.env_remove("NODE_OPTIONS");
        for (k, v) in &config.env {
            cmd.env(k, v);
        }
        tracing::info!(bin = %bin.display(), cwd = %config.cwd.display(), session_id, "spawning claude");

        let child = Arc::new(NdjsonChild::spawn(cmd)?);
        let (tx, rx) = mpsc::channel(1024);
        let session = Arc::new(ClaudeSession {
            child: child.clone(),
            events: tx,
            pending_control: Mutex::new(HashMap::new()),
            pending_permissions: Mutex::new(HashMap::new()),
            state: Mutex::new(TurnState::default()),
            session_id: Mutex::new(session_id.clone()),
        });

        // Initialize is optional; we send it to get the catalog and to be a well-behaved client.
        session.send_control_nowait("initialize", json!({})).await?;

        let reader = session.clone();
        tokio::spawn(async move { reader.read_loop().await });

        Ok(SpawnedSession { session: Box::new(SessionHandle(session)), events: rx })
    }
}

fn mode_arg(mode: PermissionMode) -> &'static str {
    match mode {
        PermissionMode::Supervised => "default",
        PermissionMode::AcceptEdits => "acceptEdits",
        PermissionMode::Auto => "auto",
        PermissionMode::FullAccess => "bypassPermissions",
    }
}

#[derive(Default)]
struct TurnState {
    /// Accumulated final text per API message id, so multi-block messages coalesce.
    text: HashMap<String, String>,
    thinking: HashMap<String, String>,
    /// Message id from the last `message_start`, used to attribute stream deltas.
    current_message: Option<String>,
    last_total_cost: f64,
    last_bound: Option<(String, Option<String>)>,
    /// uuid of the most recent assistant frame this turn (the rewind anchor).
    last_assistant_uuid: Option<String>,
    /// Our uuid for the current turn's user message.
    current_user_uuid: Option<String>,
}

struct ClaudeSession {
    child: Arc<NdjsonChild>,
    events: mpsc::Sender<DriverEvent>,
    pending_control: Mutex<HashMap<String, oneshot::Sender<std::result::Result<Value, String>>>>,
    /// request_id -> original tool input, echoed back as `updatedInput` on allow.
    pending_permissions: Mutex<HashMap<String, (Value, Vec<Value>)>>,
    state: Mutex<TurnState>,
    session_id: Mutex<String>,
}

/// Thin wrapper so the daemon owns a `Box<dyn AgentSession>` while the reader task keeps an Arc.
struct SessionHandle(Arc<ClaudeSession>);

impl ClaudeSession {
    async fn emit(&self, ev: DriverEvent) {
        let _ = self.events.send(ev).await;
    }

    async fn send_control_nowait(&self, subtype: &str, mut request: Value) -> Result<String> {
        let id = Uuid::new_v4().simple().to_string();
        request["subtype"] = Value::String(subtype.into());
        self.child.write(&json!({ "type": "control_request", "request_id": id, "request": request })).await?;
        Ok(id)
    }

    async fn send_control(&self, subtype: &str, request: Value) -> Result<Value> {
        let (tx, rx) = oneshot::channel();
        let id = Uuid::new_v4().simple().to_string();
        self.pending_control.lock().await.insert(id.clone(), tx);
        let mut request = request;
        request["subtype"] = Value::String(subtype.into());
        self.child.write(&json!({ "type": "control_request", "request_id": id, "request": request })).await?;
        match tokio::time::timeout(std::time::Duration::from_secs(30), rx).await {
            Ok(Ok(Ok(v))) => Ok(v),
            Ok(Ok(Err(e))) => Err(DriverError::Protocol(format!("{subtype}: {e}"))),
            Ok(Err(_)) => Err(DriverError::ProcessExited("claude exited while waiting for a control response".into())),
            Err(_) => {
                self.pending_control.lock().await.remove(&id);
                Err(DriverError::Protocol(format!("{subtype}: timed out")))
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
            self.handle_frame(v).await;
        }
        let code = self.child.wait().await;
        let stderr_tail = {
            let mut rx = self.child.stderr.lock().await;
            let mut lines = Vec::new();
            while let Ok(l) = rx.try_recv() {
                lines.push(l);
            }
            lines.into_iter().rev().take(5).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n")
        };
        for (_, tx) in self.pending_control.lock().await.drain() {
            let _ = tx.send(Err("process exited".into()));
        }
        let error = match code {
            Some(0) | None => None,
            Some(c) => Some(if stderr_tail.is_empty() { format!("exit code {c}") } else { stderr_tail }),
        };
        self.emit(DriverEvent::Exited { code, error }).await;
    }

    async fn handle_frame(&self, v: Value) {
        let ty = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match ty {
            "control_response" => {
                let resp = &v["response"];
                let id = resp.get("request_id").and_then(|r| r.as_str()).unwrap_or("").to_string();
                if let Some(tx) = self.pending_control.lock().await.remove(&id) {
                    let out = if resp.get("subtype").and_then(|s| s.as_str()) == Some("success") {
                        Ok(resp.get("response").cloned().unwrap_or(Value::Null))
                    } else {
                        Err(resp.get("error").and_then(|e| e.as_str()).unwrap_or("unknown error").to_string())
                    };
                    let _ = tx.send(out);
                }
            }
            "control_request" => self.handle_control_request(&v).await,
            "control_cancel_request" => {
                let id = v.get("request_id").and_then(|r| r.as_str()).unwrap_or("").to_string();
                if self.pending_permissions.lock().await.remove(&id).is_some() {
                    self.emit(DriverEvent::PermissionWithdrawn { request_id: id }).await;
                }
            }
            "keep_alive" => {}
            "system" => self.handle_system(&v).await,
            "stream_event" => self.handle_stream_event(&v).await,
            "assistant" => self.handle_assistant(&v).await,
            "user" => self.handle_user(&v).await,
            "result" => self.handle_result(&v).await,
            "rate_limit_event" => {
                let info = &v["rate_limit_info"];
                if info.get("status").and_then(|s| s.as_str()).is_some_and(|s| s != "allowed" && s != "ok") {
                    self.emit(DriverEvent::Notice {
                        level: NoticeLevel::Warning,
                        text: format!("rate limit: {}", info.get("status").and_then(|s| s.as_str()).unwrap_or("")),
                        data: Some(info.clone()),
                    })
                    .await;
                }
            }
            _ => tracing::trace!(frame = %ty, "ignored claude frame"),
        }
    }

    async fn handle_control_request(&self, v: &Value) {
        let request_id = v.get("request_id").and_then(|r| r.as_str()).unwrap_or("").to_string();
        let req = &v["request"];
        let subtype = req.get("subtype").and_then(|s| s.as_str()).unwrap_or("");
        match subtype {
            "can_use_tool" => {
                let tool_name = req.get("tool_name").and_then(|s| s.as_str()).unwrap_or("tool").to_string();
                let input = req.get("input").cloned().unwrap_or(Value::Null);
                let suggestions = req.get("permission_suggestions").and_then(|s| s.as_array()).cloned().unwrap_or_default();
                let tool_call_id = req.get("tool_use_id").and_then(|s| s.as_str()).map(str::to_string);
                let summary = match req.get("description").and_then(|s| s.as_str()) {
                    Some(d) if !d.is_empty() => format!("{tool_name}: {d}"),
                    _ => summarize_tool_call(&tool_name, &input),
                };
                self.pending_permissions.lock().await.insert(request_id.clone(), (input.clone(), suggestions.clone()));
                self.emit(DriverEvent::PermissionRequest { request_id, tool_call_id, tool_name, input, summary, suggestions }).await;
            }
            "elicitation" => {
                let _ = self.respond_control(&request_id, Ok(json!({ "action": "decline" }))).await;
            }
            "hook_callback" => {
                let _ = self.respond_control(&request_id, Ok(json!({ "continue": true }))).await;
            }
            other => {
                tracing::debug!(subtype = other, "unsupported control request from claude");
                let _ = self.respond_control(&request_id, Err(format!("kybern does not support {other}"))).await;
            }
        }
    }

    async fn respond_control(&self, request_id: &str, result: std::result::Result<Value, String>) -> Result<()> {
        let response = match result {
            Ok(r) => json!({ "subtype": "success", "request_id": request_id, "response": r }),
            Err(e) => json!({ "subtype": "error", "request_id": request_id, "error": e }),
        };
        self.child.write(&json!({ "type": "control_response", "response": response })).await
    }

    async fn handle_system(&self, v: &Value) {
        match v.get("subtype").and_then(|s| s.as_str()).unwrap_or("") {
            "init" => {
                let session_id = v.get("session_id").and_then(|s| s.as_str()).unwrap_or("").to_string();
                let model = v.get("model").and_then(|s| s.as_str()).map(str::to_string);
                let mut st = self.state.lock().await;
                let bound = (session_id.clone(), model.clone());
                if st.last_bound.as_ref() != Some(&bound) {
                    st.last_bound = Some(bound);
                    *self.session_id.lock().await = session_id.clone();
                    drop(st);
                    self.emit(DriverEvent::SessionBound { session_id, model }).await;
                }
            }
            "status" => {
                if v.get("status").and_then(|s| s.as_str()) == Some("compacting") {
                    self.emit(DriverEvent::Notice { level: NoticeLevel::Info, text: "compacting context".into(), data: None }).await;
                }
            }
            "compact_boundary" => {
                let meta = &v["compact_metadata"];
                self.emit(DriverEvent::Notice {
                    level: NoticeLevel::Info,
                    text: format!(
                        "context compacted ({} → {} tokens)",
                        meta.get("pre_tokens").and_then(|t| t.as_u64()).unwrap_or(0),
                        meta.get("post_tokens").and_then(|t| t.as_u64()).unwrap_or(0)
                    ),
                    data: Some(meta.clone()),
                })
                .await;
            }
            "permission_denied" => {
                self.emit(DriverEvent::Notice {
                    level: NoticeLevel::Warning,
                    text: format!(
                        "{} denied: {}",
                        v.get("tool_name").and_then(|s| s.as_str()).unwrap_or("tool"),
                        v.get("message").and_then(|s| s.as_str()).unwrap_or("")
                    ),
                    data: None,
                })
                .await;
            }
            "informational" => {
                let level = match v.get("level").and_then(|s| s.as_str()) {
                    Some("warning") => NoticeLevel::Warning,
                    _ => NoticeLevel::Info,
                };
                self.emit(DriverEvent::Notice { level, text: v.get("content").and_then(|s| s.as_str()).unwrap_or("").to_string(), data: None }).await;
            }
            "task_started" => {
                self.emit(DriverEvent::Notice {
                    level: NoticeLevel::Info,
                    text: format!("subagent started: {}", v.get("description").and_then(|s| s.as_str()).unwrap_or("")),
                    data: Some(v.clone()),
                })
                .await;
            }
            _ => {}
        }
    }

    async fn handle_stream_event(&self, v: &Value) {
        // Only the main thread's text is the assistant transcript; subagent output stays inside its tool call.
        if !v.get("parent_tool_use_id").is_none_or(Value::is_null) {
            return;
        }
        let ev = &v["event"];
        match ev.get("type").and_then(|t| t.as_str()).unwrap_or("") {
            "message_start" => {
                if let Some(id) = ev.pointer("/message/id").and_then(|i| i.as_str()) {
                    self.state.lock().await.current_message = Some(id.to_string());
                }
            }
            "content_block_delta" => {
                let delta = &ev["delta"];
                let message_id = match self.state.lock().await.current_message.clone() {
                    Some(id) => id,
                    None => return,
                };
                match delta.get("type").and_then(|t| t.as_str()) {
                    Some("text_delta") => {
                        if let Some(text) = delta.get("text").and_then(|t| t.as_str()) {
                            self.emit(DriverEvent::TextDelta { message_id, delta: text.to_string() }).await;
                        }
                    }
                    Some("thinking_delta") => {
                        if let Some(text) = delta.get("thinking").and_then(|t| t.as_str()) {
                            self.emit(DriverEvent::ThinkingDelta { message_id, delta: text.to_string() }).await;
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }

    async fn handle_assistant(&self, v: &Value) {
        let parent = v.get("parent_tool_use_id").and_then(|p| p.as_str()).map(str::to_string);
        if parent.is_none() {
            if let Some(u) = v.get("uuid").and_then(|u| u.as_str()) {
                self.state.lock().await.last_assistant_uuid = Some(u.to_string());
            }
        }
        let msg = &v["message"];
        let message_id = msg.get("id").and_then(|i| i.as_str()).unwrap_or("").to_string();
        if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
            self.emit(DriverEvent::Notice { level: NoticeLevel::Error, text: format!("API error: {err}"), data: Some(msg.clone()) }).await;
        }
        let Some(blocks) = msg.get("content").and_then(|c| c.as_array()) else { return };
        for block in blocks {
            match block.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                "text" if parent.is_none() => {
                    let text = block.get("text").and_then(|t| t.as_str()).unwrap_or("");
                    let mut st = self.state.lock().await;
                    let acc = st.text.entry(message_id.clone()).or_default();
                    acc.push_str(text);
                    let full = acc.clone();
                    let thinking = st.thinking.get(&message_id).cloned();
                    drop(st);
                    self.emit(DriverEvent::MessageCompleted { message_id: message_id.clone(), text: full, thinking }).await;
                }
                "thinking" if parent.is_none() => {
                    let text = block.get("thinking").and_then(|t| t.as_str()).unwrap_or("");
                    self.state.lock().await.thinking.entry(message_id.clone()).or_default().push_str(text);
                }
                "tool_use" => {
                    self.emit(DriverEvent::ToolStarted(ToolCall {
                        id: block.get("id").and_then(|i| i.as_str()).unwrap_or("").to_string(),
                        name: block.get("name").and_then(|n| n.as_str()).unwrap_or("tool").to_string(),
                        input: block.get("input").cloned().unwrap_or(Value::Null),
                        parent_id: parent.clone(),
                    }))
                    .await;
                }
                _ => {}
            }
        }
    }

    async fn handle_user(&self, v: &Value) {
        if v.get("isReplay").and_then(|r| r.as_bool()).unwrap_or(false) {
            return;
        }
        let Some(blocks) = v.pointer("/message/content").and_then(|c| c.as_array()) else { return };
        let structured = v.get("tool_use_result").cloned();
        for block in blocks {
            if block.get("type").and_then(|t| t.as_str()) != Some("tool_result") {
                continue;
            }
            let id = block.get("tool_use_id").and_then(|i| i.as_str()).unwrap_or("").to_string();
            let is_error = block.get("is_error").and_then(|e| e.as_bool()).unwrap_or(false);
            let content = block.get("content").cloned().unwrap_or(Value::Null);
            let output = match &structured {
                Some(s) if blocks.len() == 1 => json!({ "content": content, "structured": s }),
                _ => json!({ "content": content }),
            };
            self.emit(DriverEvent::ToolCompleted { tool_call_id: id, output, is_error }).await;
        }
    }

    async fn handle_result(&self, v: &Value) {
        let subtype = v.get("subtype").and_then(|s| s.as_str()).unwrap_or("");
        let usage = v.get("usage").map(parse_usage).unwrap_or_default();
        let duration_ms = v.get("duration_ms").and_then(|d| d.as_u64()).unwrap_or(0);
        let total_cost = v.get("total_cost_usd").and_then(|c| c.as_f64()).unwrap_or(0.0);
        let (cost_usd, anchors) = {
            let mut st = self.state.lock().await;
            let delta = (total_cost - st.last_total_cost).max(0.0);
            st.last_total_cost = total_cost;
            st.text.clear();
            st.thinking.clear();
            st.current_message = None;
            let anchors = crate::TurnAnchors { turn_id: st.current_user_uuid.take(), previous_end: st.last_assistant_uuid.take() };
            (Some(delta), anchors)
        };
        let terminal = v.get("terminal_reason").and_then(|t| t.as_str()).unwrap_or("");
        let errors = v
            .get("errors")
            .and_then(|e| e.as_array())
            .map(|a| a.iter().filter_map(|e| e.as_str()).collect::<Vec<_>>().join("; "))
            .unwrap_or_default();
        let ev = match subtype {
            "success" => DriverEvent::TurnCompleted { stop_reason: StopReason::Completed, usage, cost_usd, duration_ms, anchors },
            "error_max_turns" => DriverEvent::TurnCompleted { stop_reason: StopReason::MaxTurns, usage, cost_usd, duration_ms, anchors },
            _ if terminal == "aborted_streaming" || terminal == "aborted" => {
                DriverEvent::TurnCompleted { stop_reason: StopReason::Interrupted, usage, cost_usd, duration_ms, anchors }
            }
            _ => DriverEvent::TurnFailed { error: if errors.is_empty() { format!("claude: {subtype}") } else { errors } },
        };
        self.emit(ev).await;
    }
}

fn parse_usage(u: &Value) -> Usage {
    let g = |k: &str| u.get(k).and_then(|v| v.as_u64()).unwrap_or(0);
    Usage {
        input_tokens: g("input_tokens"),
        output_tokens: g("output_tokens"),
        cache_read_tokens: g("cache_read_input_tokens"),
        cache_write_tokens: g("cache_creation_input_tokens"),
    }
}

fn content_blocks(message: &UserMessage) -> Vec<Value> {
    let mut blocks = Vec::new();
    for part in &message.parts {
        match part {
            ContentPart::Text { text } => blocks.push(json!({ "type": "text", "text": text })),
            ContentPart::FileMention { path } => blocks.push(json!({ "type": "text", "text": format!("@{path}") })),
            ContentPart::Image { media_type, data } => {
                // Validate base64 so a bad upload fails here instead of as an API error mid-turn.
                if base64::engine::general_purpose::STANDARD.decode(data).is_ok() {
                    blocks.push(json!({ "type": "image", "source": { "type": "base64", "media_type": media_type, "data": data } }));
                }
            }
            ContentPart::Attachment { name, .. } => blocks.push(json!({ "type": "text", "text": format!("[attached file: {name}]") })),
        }
    }
    blocks
}

#[async_trait]
impl AgentSession for SessionHandle {
    async fn send_message(&self, message_id: &str, message: &UserMessage) -> Result<()> {
        let session_id = self.0.session_id.lock().await.clone();
        self.0.state.lock().await.current_user_uuid = Some(message_id.to_string());
        self.0
            .child
            .write(&json!({
                "type": "user",
                "uuid": message_id,
                "session_id": session_id,
                "message": { "role": "user", "content": content_blocks(message) },
                "parent_tool_use_id": null,
            }))
            .await
    }

    async fn interrupt(&self) -> Result<()> {
        self.0.send_control("interrupt", json!({})).await.map(|_| ())
    }

    async fn set_permission_mode(&self, mode: PermissionMode) -> Result<()> {
        if mode == PermissionMode::FullAccess {
            // bypassPermissions can only be enabled at spawn time with the explicit flag.
            return Err(DriverError::Unsupported("switch to Full access requires restarting the session".into()));
        }
        self.0.send_control("set_permission_mode", json!({ "mode": mode_arg(mode) })).await.map(|_| ())
    }

    async fn set_model(&self, model: &str) -> Result<()> {
        self.0.send_control("set_model", json!({ "model": model })).await.map(|_| ())
    }

    async fn respond_permission(&self, request_id: &str, decision: &ApprovalDecision) -> Result<()> {
        let Some((input, suggestions)) = self.0.pending_permissions.lock().await.remove(request_id) else {
            return Err(DriverError::Protocol(format!("no pending permission request {request_id}")));
        };
        let response = match decision {
            ApprovalDecision::AllowOnce => json!({ "behavior": "allow", "updatedInput": input }),
            ApprovalDecision::AllowAlways => {
                json!({ "behavior": "allow", "updatedInput": input, "updatedPermissions": suggestions })
            }
            ApprovalDecision::Deny { reason } => json!({
                "behavior": "deny",
                "message": reason.clone().unwrap_or_else(|| "The user declined this action.".into()),
                "interrupt": false,
            }),
        };
        self.0.respond_control(request_id, Ok(response)).await
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
