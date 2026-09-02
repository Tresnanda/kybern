//! Codex driver: speaks `codex app-server` (JSON-RPC 2.0 without the
//! `jsonrpc` member, newline-delimited over stdio).
//!
//! One app-server process per kybern thread, hosting one Codex thread. The
//! server sends requests of its own for approvals; those become permission
//! requests and are answered by id.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use async_trait::async_trait;
use base64::Engine;
use kybern_protocol::*;
use serde_json::{Value, json};
use tokio::process::Command;
use tokio::sync::{Mutex, mpsc, oneshot};

use crate::binary::{at_least, resolve, version_of};
use crate::ndjson::NdjsonChild;
use crate::{AgentDriver, AgentSession, DriverError, DriverEvent, Result, SessionConfig, SpawnedSession};

const MIN_VERSION: (u64, u64, u64) = (0, 140, 0);

#[derive(Default)]
pub struct CodexDriver;

#[async_trait]
impl AgentDriver for CodexDriver {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Codex
    }

    async fn probe(&self, binary: Option<&PathBuf>) -> ProviderStatus {
        let mut status = ProviderStatus {
            kind: ProviderKind::Codex,
            display_name: ProviderKind::Codex.display_name().into(),
            available: false,
            binary_path: None,
            version: None,
            unavailable_reason: None,
            supported_permission_modes: PermissionMode::ALL.to_vec(),
            supports_fork: true,
            supports_model_switch: true,
            instances: vec!["default".into()],
        };
        let bin = match resolve(ProviderKind::Codex, binary) {
            Ok(b) => b,
            Err(e) => {
                status.unavailable_reason = Some(format!("{e}. Install with: npm install -g @openai/codex"));
                return status;
            }
        };
        status.binary_path = Some(bin.display().to_string());
        match version_of(&bin, &["--version"]).await {
            Some(v) => {
                let ok = at_least(&v, MIN_VERSION);
                status.available = ok;
                if !ok {
                    status.unavailable_reason = Some(format!("Codex {v} is older than the required {}.{}.{}", MIN_VERSION.0, MIN_VERSION.1, MIN_VERSION.2));
                }
                status.version = Some(v);
            }
            None => status.unavailable_reason = Some("could not run `codex --version`".into()),
        }
        status
    }

    async fn one_shot(&self, cwd: &std::path::Path, prompt: &str, binary: Option<&PathBuf>) -> Result<String> {
        let bin = resolve(ProviderKind::Codex, binary)?;
        let dir = tempfile_dir()?;
        let last = dir.join("last.txt");
        let out = tokio::time::timeout(
            std::time::Duration::from_secs(90),
            Command::new(&bin)
                .current_dir(cwd)
                .args(["exec", "-s", "read-only", "--skip-git-repo-check", "--output-last-message"])
                .arg(&last)
                .arg(prompt)
                .stdin(std::process::Stdio::null())
                .output(),
        )
        .await
        .map_err(|_| DriverError::Protocol("codex one-shot timed out".into()))??;
        if !out.status.success() {
            return Err(DriverError::Protocol(format!("codex exited with {}", out.status)));
        }
        let text = tokio::fs::read_to_string(&last).await.unwrap_or_else(|_| String::from_utf8_lossy(&out.stdout).to_string());
        let _ = tokio::fs::remove_dir_all(&dir).await;
        Ok(text.trim().to_string())
    }

    async fn spawn(&self, config: SessionConfig) -> Result<SpawnedSession> {
        let bin = resolve(ProviderKind::Codex, config.binary.as_ref())?;
        let mut cmd = Command::new(&bin);
        cmd.current_dir(&config.cwd).arg("app-server");
        for (k, v) in &config.env {
            cmd.env(k, v);
        }
        tracing::info!(bin = %bin.display(), cwd = %config.cwd.display(), "spawning codex app-server");
        let child = Arc::new(NdjsonChild::spawn(cmd)?);

        let (tx, rx) = mpsc::channel(1024);
        let session = Arc::new(CodexSession {
            child,
            events: tx,
            next_id: AtomicI64::new(1),
            pending: Mutex::new(HashMap::new()),
            pending_approvals: Mutex::new(HashMap::new()),
            state: Mutex::new(State {
                thread_id: None,
                turn_id: None,
                mode: config.permission_mode,
                model: config.model.clone(),
                cwd: config.cwd.clone(),
                last_total_tokens: None,
                message_ids: HashMap::new(),
                file_changes: HashMap::new(),
            }),
            turn_usage: Mutex::new(None),
        });
        let reader = session.clone();
        tokio::spawn(async move { reader.read_loop().await });

        session
            .call(
                "initialize",
                json!({
                    "clientInfo": { "name": "kybern", "title": "kybern", "version": env!("CARGO_PKG_VERSION") },
                    "capabilities": { "experimentalApi": false }
                }),
            )
            .await?;
        session.child.write(&json!({ "method": "initialized" })).await?;

        let (approval, sandbox) = policy_for(config.permission_mode);
        let mut params = json!({ "cwd": config.cwd, "approvalPolicy": approval, "sandbox": sandbox });
        if let Some(m) = &config.model {
            params["model"] = Value::String(m.clone());
        }
        let (method, params) = match (&config.resume_session_id, config.fork) {
            (Some(id), false) => {
                params["threadId"] = Value::String(id.clone());
                ("thread/resume", params)
            }
            (Some(id), true) => {
                params["threadId"] = Value::String(id.clone());
                if let Some(turn) = config.rewind.as_ref().and_then(|r| r.drop_from.turn_id.clone()) {
                    params["beforeTurnId"] = Value::String(turn);
                }
                ("thread/fork", params)
            }
            (None, _) => ("thread/start", params),
        };
        let resp = session.call(method, params).await?;
        let thread_id = resp
            .pointer("/thread/id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| DriverError::Protocol(format!("{method}: no thread id in response")))?
            .to_string();
        let model = resp.get("model").and_then(|m| m.as_str()).map(str::to_string);
        {
            let mut st = session.state.lock().await;
            st.thread_id = Some(thread_id.clone());
            if model.is_some() {
                st.model = model.clone();
            }
        }
        session.emit(DriverEvent::SessionBound { session_id: thread_id, model }).await;

        Ok(SpawnedSession { session: Box::new(Handle(session)), events: rx })
    }
}

/// (approvalPolicy, sandbox mode) for a kybern permission mode.
fn policy_for(mode: PermissionMode) -> (&'static str, &'static str) {
    match mode {
        PermissionMode::Supervised => ("untrusted", "workspace-write"),
        PermissionMode::AcceptEdits => ("on-request", "workspace-write"),
        PermissionMode::Auto => ("never", "workspace-write"),
        PermissionMode::FullAccess => ("never", "danger-full-access"),
    }
}

fn sandbox_policy_for(mode: PermissionMode, cwd: &std::path::Path) -> Value {
    match mode {
        PermissionMode::FullAccess => json!({ "type": "dangerFullAccess" }),
        _ => json!({ "type": "workspaceWrite", "writableRoots": [cwd], "networkAccess": false, "excludeTmpdirEnvVar": false, "excludeSlashTmp": false }),
    }
}

struct State {
    thread_id: Option<String>,
    turn_id: Option<String>,
    mode: PermissionMode,
    model: Option<String>,
    cwd: PathBuf,
    /// Cumulative thread total at the end of the previous turn, to compute per-turn usage.
    last_total_tokens: Option<Usage>,
    /// Agent message item ids seen this turn (for completion bookkeeping).
    message_ids: HashMap<String, ()>,
    /// fileChange item id -> changes[], so the approval card can show the diff.
    file_changes: HashMap<String, Value>,
}

struct CodexSession {
    child: Arc<NdjsonChild>,
    events: mpsc::Sender<DriverEvent>,
    next_id: AtomicI64,
    pending: Mutex<HashMap<i64, oneshot::Sender<std::result::Result<Value, String>>>>,
    /// Our request key -> (server request id, kind) for approvals awaiting the user.
    pending_approvals: Mutex<HashMap<String, (Value, ApprovalKind)>>,
    state: Mutex<State>,
    /// Per-turn usage derived from thread totals, consumed at turn/completed.
    turn_usage: Mutex<Option<Usage>>,
}

#[derive(Clone, Copy)]
enum ApprovalKind {
    Command,
    FileChange,
}

struct Handle(Arc<CodexSession>);

impl CodexSession {
    async fn emit(&self, ev: DriverEvent) {
        let _ = self.events.send(ev).await;
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        self.child.write(&json!({ "id": id, "method": method, "params": params })).await?;
        match tokio::time::timeout(std::time::Duration::from_secs(120), rx).await {
            Ok(Ok(Ok(v))) => Ok(v),
            Ok(Ok(Err(e))) => Err(DriverError::Protocol(format!("{method}: {e}"))),
            Ok(Err(_)) => Err(DriverError::ProcessExited("codex exited while waiting for a response".into())),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(DriverError::Protocol(format!("{method}: timed out")))
            }
        }
    }

    async fn respond(&self, id: &Value, result: std::result::Result<Value, String>) -> Result<()> {
        let frame = match result {
            Ok(r) => json!({ "id": id, "result": r }),
            Err(e) => json!({ "id": id, "error": { "code": -32601, "message": e } }),
        };
        self.child.write(&frame).await
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
        for (_, tx) in self.pending.lock().await.drain() {
            let _ = tx.send(Err("process exited".into()));
        }
        let error = match code {
            Some(0) | None => None,
            Some(c) => Some(format!("exit code {c}")),
        };
        self.emit(DriverEvent::Exited { code, error }).await;
    }

    async fn handle_frame(&self, v: Value) {
        let has_id = v.get("id").is_some_and(|i| !i.is_null());
        let method = v.get("method").and_then(|m| m.as_str());
        match (has_id, method) {
            (true, Some(m)) => self.handle_server_request(v["id"].clone(), m, &v["params"]).await,
            (false, Some(m)) => self.handle_notification(m, &v["params"]).await,
            (true, None) => {
                let Some(id) = v["id"].as_i64() else { return };
                if let Some(tx) = self.pending.lock().await.remove(&id) {
                    let out = if let Some(err) = v.get("error") {
                        Err(err.get("message").and_then(|m| m.as_str()).unwrap_or("error").to_string())
                    } else {
                        Ok(v.get("result").cloned().unwrap_or(Value::Null))
                    };
                    let _ = tx.send(out);
                }
            }
            _ => {}
        }
    }

    async fn handle_server_request(&self, id: Value, method: &str, params: &Value) {
        let item_id = params.get("itemId").and_then(|i| i.as_str()).map(str::to_string);
        match method {
            "item/commandExecution/requestApproval" => {
                let command = params.get("command").and_then(|c| c.as_str()).unwrap_or("").to_string();
                let key = format!("cmd:{}", serde_json::to_string(&id).unwrap_or_default());
                self.pending_approvals.lock().await.insert(key.clone(), (id, ApprovalKind::Command));
                let input = json!({
                    "command": command,
                    "cwd": params.get("cwd"),
                    "reason": params.get("reason"),
                    "network": params.get("networkApprovalContext"),
                });
                let summary = if command.is_empty() {
                    match params.pointer("/networkApprovalContext/host").and_then(|h| h.as_str()) {
                        Some(host) => format!("network access to {host}"),
                        None => "run command".into(),
                    }
                } else {
                    format!("run: {}", command.lines().next().unwrap_or("").chars().take(120).collect::<String>())
                };
                self.emit(DriverEvent::PermissionRequest { request_id: key, tool_call_id: item_id, tool_name: "shell".into(), input, summary, suggestions: vec![] }).await;
            }
            "item/fileChange/requestApproval" => {
                let mode = self.state.lock().await.mode;
                if matches!(mode, PermissionMode::AcceptEdits | PermissionMode::Auto | PermissionMode::FullAccess) {
                    let _ = self.respond(&id, Ok(json!({ "decision": "accept" }))).await;
                    return;
                }
                let key = format!("patch:{}", serde_json::to_string(&id).unwrap_or_default());
                self.pending_approvals.lock().await.insert(key.clone(), (id, ApprovalKind::FileChange));
                let changes = match &item_id {
                    Some(i) => self.state.lock().await.file_changes.get(i).cloned().unwrap_or(Value::Null),
                    None => Value::Null,
                };
                let paths: Vec<String> = changes
                    .as_array()
                    .map(|a| a.iter().filter_map(|c| c.get("path").and_then(|p| p.as_str()).map(str::to_string)).collect())
                    .unwrap_or_default();
                let summary = if paths.is_empty() { "apply file changes".to_string() } else { format!("edit: {}", paths.join(", ")) };
                let input = json!({ "changes": changes, "reason": params.get("reason"), "grant_root": params.get("grantRoot") });
                self.emit(DriverEvent::PermissionRequest {
                    request_id: key,
                    tool_call_id: item_id,
                    tool_name: "apply_patch".into(),
                    input,
                    summary,
                    suggestions: vec![],
                })
                .await;
            }
            "item/tool/requestUserInput" => {
                // Not mappable to yes/no approvals yet; decline so the turn continues.
                let _ = self.respond(&id, Err("kybern does not support tool questions yet".into())).await;
                self.emit(DriverEvent::Notice { level: NoticeLevel::Warning, text: "Codex asked a question kybern cannot relay yet".into(), data: Some(params.clone()) }).await;
            }
            other => {
                let _ = self.respond(&id, Err(format!("kybern does not support {other}"))).await;
            }
        }
    }

    async fn handle_notification(&self, method: &str, p: &Value) {
        match method {
            "turn/started" => {
                if let Some(id) = p.pointer("/turn/id").and_then(|i| i.as_str()) {
                    self.state.lock().await.turn_id = Some(id.to_string());
                }
            }
            "item/started" => self.handle_item(&p["item"], false).await,
            "item/completed" => self.handle_item(&p["item"], true).await,
            "item/agentMessage/delta" => {
                if let (Some(id), Some(delta)) = (p.get("itemId").and_then(|i| i.as_str()), p.get("delta").and_then(|d| d.as_str())) {
                    self.emit(DriverEvent::TextDelta { message_id: id.to_string(), delta: delta.to_string() }).await;
                }
            }
            "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta" => {
                if let (Some(id), Some(delta)) = (p.get("itemId").and_then(|i| i.as_str()), p.get("delta").and_then(|d| d.as_str())) {
                    // Attribute reasoning to the turn's current message stream under the reasoning item id.
                    self.emit(DriverEvent::ThinkingDelta { message_id: id.to_string(), delta: delta.to_string() }).await;
                }
            }
            "item/commandExecution/outputDelta" => {
                if let (Some(id), Some(delta)) = (p.get("itemId").and_then(|i| i.as_str()), p.get("delta").and_then(|d| d.as_str())) {
                    self.emit(DriverEvent::ToolOutputDelta { tool_call_id: id.to_string(), delta: delta.to_string() }).await;
                }
            }
            "turn/plan/updated" => {
                let steps = p.get("plan").and_then(|s| s.as_array()).map(|a| a.len()).unwrap_or(0);
                self.emit(DriverEvent::Notice { level: NoticeLevel::Info, text: format!("plan updated ({steps} steps)"), data: Some(p.clone()) }).await;
            }
            "thread/tokenUsage/updated" => {
                let total = p.pointer("/tokenUsage/total").map(parse_usage).unwrap_or_default();
                let mut st = self.state.lock().await;
                let per_turn = match &st.last_total_tokens {
                    Some(prev) => Usage {
                        input_tokens: total.input_tokens.saturating_sub(prev.input_tokens),
                        output_tokens: total.output_tokens.saturating_sub(prev.output_tokens),
                        cache_read_tokens: total.cache_read_tokens.saturating_sub(prev.cache_read_tokens),
                        cache_write_tokens: total.cache_write_tokens.saturating_sub(prev.cache_write_tokens),
                    },
                    None => total.clone(),
                };
                st.last_total_tokens = Some(total);
                drop(st);
                *self.turn_usage.lock().await = Some(per_turn);
            }
            "turn/completed" => {
                let turn = &p["turn"];
                let status = turn.get("status").and_then(|s| s.as_str()).unwrap_or("completed");
                let duration_ms = turn.get("durationMs").and_then(|d| d.as_u64()).unwrap_or(0);
                let usage = self.turn_usage.lock().await.take().unwrap_or_default();
                let anchors = crate::TurnAnchors { turn_id: turn.get("id").and_then(|i| i.as_str()).map(str::to_string), previous_end: None };
                {
                    let mut st = self.state.lock().await;
                    st.turn_id = None;
                    st.message_ids.clear();
                    st.file_changes.clear();
                }
                self.pending_approvals.lock().await.clear();
                let ev = match status {
                    "completed" => DriverEvent::TurnCompleted { stop_reason: StopReason::Completed, usage, cost_usd: None, duration_ms, anchors },
                    "interrupted" => DriverEvent::TurnCompleted { stop_reason: StopReason::Interrupted, usage, cost_usd: None, duration_ms, anchors },
                    _ => DriverEvent::TurnFailed {
                        error: turn.pointer("/error/message").and_then(|m| m.as_str()).unwrap_or("turn failed").to_string(),
                    },
                };
                self.emit(ev).await;
            }
            "error" => {
                let msg = p.pointer("/error/message").and_then(|m| m.as_str()).unwrap_or("error").to_string();
                let retry = p.get("willRetry").and_then(|r| r.as_bool()).unwrap_or(false);
                self.emit(DriverEvent::Notice {
                    level: if retry { NoticeLevel::Warning } else { NoticeLevel::Error },
                    text: if retry { format!("{msg} (retrying)") } else { msg },
                    data: Some(p.clone()),
                })
                .await;
            }
            "warning" | "configWarning" | "deprecationNotice" => {
                let text = p.get("message").or_else(|| p.get("summary")).and_then(|m| m.as_str()).unwrap_or("").to_string();
                if !text.is_empty() {
                    self.emit(DriverEvent::Notice { level: NoticeLevel::Warning, text, data: None }).await;
                }
            }
            "serverRequest/resolved" => {
                // A pending approval was resolved elsewhere (interrupt). Drop it if still pending.
                let rid = p.get("requestId").cloned().unwrap_or(Value::Null);
                let mut pend = self.pending_approvals.lock().await;
                if let Some(key) = pend.iter().find(|(_, (id, _))| *id == rid).map(|(k, _)| k.clone()) {
                    pend.remove(&key);
                    drop(pend);
                    self.emit(DriverEvent::PermissionWithdrawn { request_id: key }).await;
                }
            }
            "thread/settings/updated" => {
                if let Some(model) = p.pointer("/threadSettings/model").and_then(|m| m.as_str()) {
                    let mut st = self.state.lock().await;
                    if st.model.as_deref() != Some(model) {
                        st.model = Some(model.to_string());
                        let tid = st.thread_id.clone().unwrap_or_default();
                        drop(st);
                        self.emit(DriverEvent::SessionBound { session_id: tid, model: Some(model.to_string()) }).await;
                    }
                }
            }
            _ => tracing::trace!(method, "ignored codex notification"),
        }
    }

    async fn handle_item(&self, item: &Value, completed: bool) {
        let ty = item.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let id = item.get("id").and_then(|i| i.as_str()).unwrap_or("").to_string();
        match ty {
            "agentMessage" => {
                if completed {
                    let text = item.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string();
                    self.emit(DriverEvent::MessageCompleted { message_id: id, text, thinking: None }).await;
                }
            }
            "reasoning" => {
                if completed {
                    let summary = item.get("summary").and_then(|s| s.as_array()).map(|a| a.iter().filter_map(|s| s.as_str()).collect::<Vec<_>>().join("\n\n")).unwrap_or_default();
                    if !summary.is_empty() {
                        // Reasoning belongs to the next agent message; surfaced as a notice with data for the UI.
                        self.emit(DriverEvent::Notice { level: NoticeLevel::Info, text: "reasoning".into(), data: Some(json!({ "reasoning": summary, "item_id": id })) }).await;
                    }
                }
            }
            "commandExecution" => {
                if !completed {
                    self.emit(DriverEvent::ToolStarted(ToolCall {
                        id,
                        name: "shell".into(),
                        input: json!({ "command": item.get("command"), "cwd": item.get("cwd"), "actions": item.get("commandActions") }),
                        parent_id: None,
                    }))
                    .await;
                } else {
                    let status = item.get("status").and_then(|s| s.as_str()).unwrap_or("");
                    self.emit(DriverEvent::ToolCompleted {
                        tool_call_id: id,
                        output: json!({ "content": item.get("aggregatedOutput"), "exit_code": item.get("exitCode"), "status": status, "duration_ms": item.get("durationMs") }),
                        is_error: matches!(status, "failed" | "declined"),
                    })
                    .await;
                }
            }
            "fileChange" => {
                let changes = item.get("changes").cloned().unwrap_or(Value::Array(vec![]));
                if !completed {
                    self.state.lock().await.file_changes.insert(id.clone(), changes.clone());
                    self.emit(DriverEvent::ToolStarted(ToolCall { id, name: "apply_patch".into(), input: json!({ "changes": changes }), parent_id: None })).await;
                } else {
                    let status = item.get("status").and_then(|s| s.as_str()).unwrap_or("");
                    self.emit(DriverEvent::ToolCompleted {
                        tool_call_id: id,
                        output: json!({ "status": status, "changes": changes }),
                        is_error: matches!(status, "failed" | "declined"),
                    })
                    .await;
                }
            }
            "mcpToolCall" => {
                let name = format!("mcp:{}/{}", item.get("server").and_then(|s| s.as_str()).unwrap_or(""), item.get("tool").and_then(|s| s.as_str()).unwrap_or(""));
                if !completed {
                    self.emit(DriverEvent::ToolStarted(ToolCall { id, name, input: item.get("arguments").cloned().unwrap_or(Value::Null), parent_id: None })).await;
                } else {
                    let status = item.get("status").and_then(|s| s.as_str()).unwrap_or("");
                    self.emit(DriverEvent::ToolCompleted {
                        tool_call_id: id,
                        output: json!({ "result": item.get("result"), "error": item.get("error"), "status": status }),
                        is_error: status == "failed" || !item.get("error").is_none_or(Value::is_null),
                    })
                    .await;
                }
            }
            "webSearch" => {
                if !completed {
                    self.emit(DriverEvent::ToolStarted(ToolCall { id, name: "web_search".into(), input: json!({ "query": item.get("query"), "action": item.get("action") }), parent_id: None })).await;
                } else {
                    self.emit(DriverEvent::ToolCompleted { tool_call_id: id, output: json!({ "results": item.get("results") }), is_error: false }).await;
                }
            }
            "imageView" | "imageGeneration" | "dynamicToolCall" => {
                if !completed {
                    self.emit(DriverEvent::ToolStarted(ToolCall { id, name: ty.to_string(), input: item.clone(), parent_id: None })).await;
                } else {
                    self.emit(DriverEvent::ToolCompleted { tool_call_id: id, output: item.clone(), is_error: false }).await;
                }
            }
            "contextCompaction" => {
                if completed {
                    self.emit(DriverEvent::Notice { level: NoticeLevel::Info, text: "context compacted".into(), data: None }).await;
                }
            }
            _ => {}
        }
    }
}

fn tempfile_dir() -> Result<PathBuf> {
    let dir = std::env::temp_dir().join(format!("kybern-codex-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn parse_usage(u: &Value) -> Usage {
    let g = |k: &str| u.get(k).and_then(|v| v.as_u64()).unwrap_or(0);
    Usage {
        input_tokens: g("inputTokens"),
        output_tokens: g("outputTokens"),
        cache_read_tokens: g("cachedInputTokens"),
        cache_write_tokens: g("cacheWriteInputTokens"),
    }
}

fn input_items(message: &UserMessage) -> Vec<Value> {
    let mut items = Vec::new();
    for part in &message.parts {
        match part {
            ContentPart::Text { text } => items.push(json!({ "type": "text", "text": text, "text_elements": [] })),
            ContentPart::FileMention { path } => items.push(json!({ "type": "text", "text": format!("@{path}"), "text_elements": [] })),
            ContentPart::Image { media_type, data } => {
                if base64::engine::general_purpose::STANDARD.decode(data).is_ok() {
                    items.push(json!({ "type": "image", "url": format!("data:{media_type};base64,{data}"), "detail": "auto" }));
                }
            }
            ContentPart::Attachment { name, .. } => items.push(json!({ "type": "text", "text": format!("[attached file: {name}]"), "text_elements": [] })),
        }
    }
    items
}

#[async_trait]
impl AgentSession for Handle {
    async fn send_message(&self, message_id: &str, message: &UserMessage) -> Result<()> {
        let s = &self.0;
        let (thread_id, mode, model, cwd) = {
            let st = s.state.lock().await;
            (st.thread_id.clone().ok_or_else(|| DriverError::Protocol("no codex thread".into()))?, st.mode, st.model.clone(), st.cwd.clone())
        };
        let (approval, _) = policy_for(mode);
        let mut params = json!({
            "threadId": thread_id,
            "clientUserMessageId": message_id,
            "input": input_items(message),
            "approvalPolicy": approval,
            "sandboxPolicy": sandbox_policy_for(mode, &cwd),
        });
        if let Some(m) = model {
            params["model"] = Value::String(m);
        }
        let resp = s.call("turn/start", params).await?;
        if let Some(id) = resp.pointer("/turn/id").and_then(|i| i.as_str()) {
            s.state.lock().await.turn_id = Some(id.to_string());
        }
        Ok(())
    }

    async fn interrupt(&self) -> Result<()> {
        let (thread_id, turn_id) = {
            let st = self.0.state.lock().await;
            (st.thread_id.clone(), st.turn_id.clone())
        };
        match (thread_id, turn_id) {
            (Some(t), Some(turn)) => self.0.call("turn/interrupt", json!({ "threadId": t, "turnId": turn })).await.map(|_| ()),
            _ => Ok(()),
        }
    }

    async fn set_permission_mode(&self, mode: PermissionMode) -> Result<()> {
        self.0.state.lock().await.mode = mode;
        Ok(())
    }

    async fn set_model(&self, model: &str) -> Result<()> {
        self.0.state.lock().await.model = Some(model.to_string());
        Ok(())
    }

    async fn respond_permission(&self, request_id: &str, decision: &ApprovalDecision) -> Result<()> {
        let Some((id, _kind)) = self.0.pending_approvals.lock().await.remove(request_id) else {
            return Err(DriverError::Protocol(format!("no pending approval {request_id}")));
        };
        let d = match decision {
            ApprovalDecision::AllowOnce => "accept",
            ApprovalDecision::AllowAlways => "acceptForSession",
            ApprovalDecision::Deny { .. } => "decline",
        };
        self.0.respond(&id, Ok(json!({ "decision": d }))).await
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
