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
use crate::{
    AgentDriver, AgentSession, DriverError, DriverEvent, DriverRuntimeTask, DriverRuntimeTaskUpdate, ProbeContext, Result, SessionConfig,
    SpawnedSession, summarize_tool_call,
};

const MIN_VERSION: (u64, u64, u64) = (2, 1, 0);

#[derive(Default)]
pub struct ClaudeDriver;

#[async_trait]
impl AgentDriver for ClaudeDriver {
    fn kind(&self) -> ProviderKind {
        ProviderKind::ClaudeCode
    }

    async fn probe(&self, binary: Option<&PathBuf>) -> ProviderStatus {
        self.probe_context(&ProbeContext { binary: binary.cloned(), ..ProbeContext::default() }).await
    }

    async fn probe_with_context(&self, context: &ProbeContext) -> ProviderStatus {
        self.probe_context(context).await
    }

    async fn one_shot(&self, cwd: &std::path::Path, prompt: &str, binary: Option<&PathBuf>) -> Result<String> {
        let bin = resolve(ProviderKind::ClaudeCode, binary)?;
        let out = tokio::time::timeout(
            std::time::Duration::from_secs(60),
            Command::new(&bin)
                .current_dir(cwd)
                .args([
                    "-p",
                    "--output-format",
                    "text",
                    "--model",
                    "haiku",
                    "--max-turns",
                    "1",
                    "--no-session-persistence",
                    "--permission-mode",
                    "dontAsk",
                    "--disallowedTools",
                    "*",
                ])
                .arg(prompt)
                .env_remove("NODE_OPTIONS")
                .stdin(std::process::Stdio::null())
                .output(),
        )
        .await
        .map_err(|_| DriverError::Protocol("claude one-shot timed out".into()))??;
        if !out.status.success() {
            return Err(DriverError::Protocol(format!(
                "claude exited with {}: {}",
                out.status,
                String::from_utf8_lossy(&out.stderr).trim()
            )));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
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
        if let Some(effort) = &config.effort {
            cmd.args(["--effort", effort]);
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
        session.send_control_nowait("initialize", json!({ "supportedDialogKinds": ["resume_return"] })).await?;

        let reader = session.clone();
        tokio::spawn(async move { reader.read_loop().await });

        Ok(SpawnedSession { session: Box::new(SessionHandle(session)), events: rx })
    }
}

impl ClaudeDriver {
    async fn probe_context(&self, context: &ProbeContext) -> ProviderStatus {
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
            supports_effort_switch: false,
            supported_efforts: vec!["low".into(), "medium".into(), "high".into(), "xhigh".into(), "max".into()],
            models: vec![
                ProviderModel {
                    id: "sonnet".into(),
                    display_name: "Sonnet".into(),
                    provider: None,
                    efforts: vec!["low".into(), "medium".into(), "high".into(), "xhigh".into(), "max".into()],
                    default_effort: None,
                    is_default: false,
                },
                ProviderModel {
                    id: "opus".into(),
                    display_name: "Opus".into(),
                    provider: None,
                    efforts: vec!["low".into(), "medium".into(), "high".into(), "xhigh".into(), "max".into()],
                    default_effort: None,
                    is_default: false,
                },
            ],
            instances: vec!["default".into()],
        };
        let bin = match resolve(ProviderKind::ClaudeCode, context.binary.as_ref()) {
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
                    status.unavailable_reason =
                        Some(format!("Claude Code {v} is older than the required {}.{}.{}", MIN_VERSION.0, MIN_VERSION.1, MIN_VERSION.2));
                }
                status.version = Some(v);
            }
            None => status.unavailable_reason = Some("could not run `claude --version`".into()),
        }
        if status.available {
            let config = crate::claude_config::resolve(context, &bin).await;
            if let Ok(Ok(output)) =
                tokio::time::timeout(std::time::Duration::from_secs(2), contextual_command(&bin, context).arg("--help").output()).await
            {
                let help = String::from_utf8_lossy(&output.stdout);
                let efforts = claude_efforts(&help);
                if !efforts.is_empty() {
                    status.supported_efforts = efforts.clone();
                }
                let aliases = claude_model_aliases(&help);
                if !aliases.is_empty() {
                    let mut selectors = aliases;
                    if !selectors.iter().any(|selector| selector == &config.model) {
                        selectors.insert(0, config.model.clone());
                    }
                    let version = status.version.as_deref();
                    status.models = selectors
                        .into_iter()
                        .map(|id| ProviderModel {
                            display_name: claude_model_name(
                                &id,
                                version,
                                (id == config.model).then_some(config.alias_target.as_deref()).flatten(),
                            ),
                            is_default: id == config.model,
                            default_effort: Some(config.effort_for(&id)),
                            id,
                            provider: None,
                            efforts: status.supported_efforts.clone(),
                        })
                        .collect();
                }
            }
            if !status.models.iter().any(|model| model.is_default) {
                status.models.insert(
                    0,
                    ProviderModel {
                        id: config.model.clone(),
                        display_name: claude_model_name(&config.model, status.version.as_deref(), config.alias_target.as_deref()),
                        provider: None,
                        efforts: status.supported_efforts.clone(),
                        default_effort: Some(config.effort.clone()),
                        is_default: true,
                    },
                );
            }
        }
        status
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

fn option_excerpt<'a>(help: &'a str, flag: &str, max_len: usize) -> Option<&'a str> {
    let start = help.find(flag)?;
    let tail = &help[start..];
    let end = tail.char_indices().nth(max_len).map(|(index, _)| index).unwrap_or(tail.len());
    Some(&tail[..end])
}

fn claude_model_aliases(help: &str) -> Vec<String> {
    let Some(excerpt) = option_excerpt(help, "--model <model>", 420) else { return Vec::new() };
    let alias_text = excerpt.split("or a model's full name").next().unwrap_or(excerpt);
    let mut aliases = Vec::new();
    let mut rest = alias_text;
    while let Some(start) = rest.find('\'') {
        rest = &rest[start + 1..];
        let Some(end) = rest.find('\'') else { break };
        let value = &rest[..end];
        if !value.is_empty() && value.chars().all(|character| character.is_ascii_alphanumeric() || character == '-' || character == '_') {
            aliases.push(value.to_string());
        }
        rest = &rest[end + 1..];
    }
    aliases
}

fn claude_efforts(help: &str) -> Vec<String> {
    let Some(excerpt) = option_excerpt(help, "--effort <level>", 260) else { return Vec::new() };
    let Some(start) = excerpt.find('(') else { return Vec::new() };
    let Some(end) = excerpt[start + 1..].find(')') else { return Vec::new() };
    excerpt[start + 1..start + 1 + end]
        .split(',')
        .map(|value| value.trim().trim_start_matches("or "))
        .filter(|value| !value.is_empty() && value.chars().all(|character| character.is_ascii_alphanumeric() || character == '-'))
        .map(str::to_string)
        .collect()
}

fn contextual_command(binary: &std::path::Path, context: &ProbeContext) -> Command {
    let mut command = Command::new(binary);
    if let Some(cwd) = context.cwd.as_deref() {
        command.current_dir(cwd);
    }
    command.env_remove("NODE_OPTIONS").envs(&context.env);
    command
}

/// Friendly names follow a CLI-version-gated manifest while the
/// selector itself remains exactly what Claude Code accepts.
fn claude_model_name(selector: &str, cli_version: Option<&str>, alias_target: Option<&str>) -> String {
    let (base, context_suffix) =
        selector.split_once('[').map_or((selector, None), |(base, suffix)| (base, Some(suffix.trim_end_matches(']'))));
    let label = if let Some(target) = alias_target {
        friendly_model_id(target)
    } else {
        match base.to_ascii_lowercase().as_str() {
            "fable" if cli_version.is_some_and(|version| at_least(version, (2, 1, 257))) => "Claude Fable 5.1".into(),
            "fable" => "Claude Fable 5".into(),
            "opus" if cli_version.is_some_and(|version| at_least(version, (2, 1, 219))) => "Claude Opus 5".into(),
            "opus" => "Claude Opus".into(),
            "sonnet" => "Claude Sonnet 5".into(),
            "haiku" => "Claude Haiku".into(),
            _ => friendly_model_id(base),
        }
    };
    match context_suffix {
        Some(suffix) if suffix.eq_ignore_ascii_case("1m") => format!("{label} · 1M"),
        Some(suffix) if !suffix.is_empty() => format!("{label} · {suffix}"),
        _ => label,
    }
}

fn friendly_model_id(model: &str) -> String {
    match model.to_ascii_lowercase().as_str() {
        "claude-fable-5-1" | "claude-fable-5.1" => "Claude Fable 5.1".into(),
        "claude-fable-5" => "Claude Fable 5".into(),
        "claude-opus-5" | "claude-opus-5-0" | "claude-opus-5.0" => "Claude Opus 5".into(),
        "claude-sonnet-5" | "claude-sonnet-5-0" | "claude-sonnet-5.0" => "Claude Sonnet 5".into(),
        _ => model.to_string(),
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
                if info.get("status").and_then(|s| s.as_str()).is_some_and(|s| !s.starts_with("allowed") && s != "ok") {
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
            "request_user_dialog" => {
                if req.get("dialog_kind").and_then(Value::as_str) != Some("resume_return") {
                    // Undeclared dialogs may belong to another attached client. Do not settle them.
                    self.emit(DriverEvent::Notice {
                        level: NoticeLevel::Warning,
                        text: "Claude requested an unsupported dialog. Answer it in the originating client.".into(),
                        data: None,
                    })
                    .await;
                    return;
                }
                self.pending_permissions.lock().await.insert(request_id.clone(), (json!({ "_kybern_dialog": req }), vec![]));
                self.emit(DriverEvent::PermissionRequest {
                    request_id,
                    tool_call_id: req.get("tool_use_id").and_then(Value::as_str).map(str::to_owned),
                    tool_name: "ui_select".into(),
                    input: json!({ "title": "Resume session", "options": ["Compact and continue", "Keep full history", "Keep full history and skip future prompts"] }),
                    summary: "Resume with a summary to use fewer tokens, or keep the full conversation.".into(),
                    suggestions: vec![],
                }).await;
            }
            "elicitation" => {
                self.pending_permissions.lock().await.insert(request_id.clone(), (json!({ "_kybern_elicitation": req }), vec![]));
                self.emit(DriverEvent::PermissionRequest {
                    request_id,
                    tool_call_id: None,
                    tool_name: "mcp_elicitation".into(),
                    input: req.clone(),
                    summary: req.get("message").and_then(Value::as_str).unwrap_or("Provide the requested information").into(),
                    suggestions: vec![],
                })
                .await;
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
                self.emit(DriverEvent::Notice {
                    level,
                    text: v.get("content").and_then(|s| s.as_str()).unwrap_or("").to_string(),
                    data: None,
                })
                .await;
            }
            "task_started" => {
                if let Some(task) = claude_task_started(v) {
                    self.emit(DriverEvent::RuntimeTaskStarted(task)).await;
                }
            }
            "task_progress" | "task_updated" => {
                if let Some(update) = claude_task_update(v) {
                    let terminal = update.status.is_some_and(|status| !status.is_active());
                    self.emit(if terminal { DriverEvent::RuntimeTaskCompleted(update) } else { DriverEvent::RuntimeTaskUpdated(update) })
                        .await;
                }
            }
            "task_notification" => {
                if let Some(mut update) = claude_task_update(v) {
                    if update.status.is_none() {
                        update.status = Some(RuntimeTaskStatus::Completed);
                    }
                    self.emit(DriverEvent::RuntimeTaskCompleted(update)).await;
                }
            }
            "background_tasks_changed" => {
                if let Some(tasks) = v.get("tasks").or_else(|| v.get("running_background_tasks")).and_then(Value::as_array) {
                    for task in tasks {
                        if let Some(task) = claude_background_task(task) {
                            self.emit(DriverEvent::RuntimeTaskStarted(task)).await;
                        }
                    }
                }
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
                            self.emit(DriverEvent::TextDelta { message_id, origin: EventOrigin::Root, delta: text.to_string() }).await;
                        }
                    }
                    Some("thinking_delta") => {
                        if let Some(text) = delta.get("thinking").and_then(|t| t.as_str()) {
                            self.emit(DriverEvent::ThinkingDelta { message_id, origin: EventOrigin::Root, delta: text.to_string() }).await;
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
        if parent.is_none()
            && let Some(u) = v.get("uuid").and_then(|u| u.as_str())
        {
            self.state.lock().await.last_assistant_uuid = Some(u.to_string());
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
                    self.emit(DriverEvent::MessageCompleted {
                        message_id: message_id.clone(),
                        origin: EventOrigin::Root,
                        text: full,
                        thinking,
                    })
                    .await;
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

fn claude_task_started(value: &Value) -> Option<DriverRuntimeTask> {
    let id = value.get("task_id").or_else(|| value.get("taskId")).or_else(|| value.get("id")).and_then(Value::as_str)?.to_string();
    let provider_type = value
        .get("task_type")
        .or_else(|| value.get("taskType"))
        .or_else(|| value.get("subagent_type"))
        .or_else(|| value.get("type"))
        .and_then(Value::as_str)
        .unwrap_or("local_agent")
        .to_string();
    let kind = match provider_type.as_str() {
        "local_bash" | "shell" => RuntimeTaskKind::Process,
        "monitor" | "monitor_mcp" => RuntimeTaskKind::Monitor,
        _ => RuntimeTaskKind::Agent,
    };
    let status = value.get("status").and_then(Value::as_str).map(claude_task_status).unwrap_or(RuntimeTaskStatus::Running);
    let backgrounded = value.get("is_backgrounded").or_else(|| value.get("isBackgrounded")).and_then(Value::as_bool).unwrap_or(false);
    let tool_call_id = value.get("tool_use_id").or_else(|| value.get("toolUseId")).and_then(Value::as_str).map(str::to_string);
    let title = value
        .get("description")
        .or_else(|| value.get("summary"))
        .or_else(|| value.get("prompt"))
        .and_then(Value::as_str)
        .filter(|title| !title.trim().is_empty())
        .map(|title| title.lines().next().unwrap_or(title).chars().take(120).collect())
        .unwrap_or_else(|| match kind {
            RuntimeTaskKind::Agent => "Subagent".into(),
            RuntimeTaskKind::Process => "Background process".into(),
            RuntimeTaskKind::Monitor => "Monitor".into(),
        });
    Some(DriverRuntimeTask {
        id,
        kind,
        status,
        title,
        detail: value.get("summary").and_then(Value::as_str).map(str::to_string),
        provider_type: Some(provider_type),
        parent_id: value.get("parent_task_id").or_else(|| value.get("parentTaskId")).and_then(Value::as_str).map(str::to_string),
        tool_call_id: tool_call_id.clone(),
        provider_thread_id: None,
        model: value.get("model").and_then(Value::as_str).map(str::to_string),
        effort: None,
        backgrounded,
        last_tool_name: value.get("last_tool_name").or_else(|| value.get("lastToolName")).and_then(Value::as_str).map(str::to_string),
        usage: claude_task_usage(value.get("usage")),
        stats: claude_task_stats(value.get("usage")),
        capabilities: RuntimeTaskCapabilities {
            stop: status.is_active(),
            background: status.is_active() && !backgrounded && tool_call_id.is_some() && kind != RuntimeTaskKind::Monitor,
        },
    })
}

fn claude_background_task(value: &Value) -> Option<DriverRuntimeTask> {
    let mut task = claude_task_started(value)?;
    // `background_tasks_changed` is the full background roster; individual
    // rows do not repeat the background flag.
    task.backgrounded = true;
    task.capabilities.background = false;
    Some(task)
}

fn claude_task_update(value: &Value) -> Option<DriverRuntimeTaskUpdate> {
    let patch = value.get("patch").unwrap_or(value);
    let id = value
        .get("task_id")
        .or_else(|| value.get("taskId"))
        .or_else(|| value.get("id"))
        .or_else(|| patch.get("task_id"))
        .or_else(|| patch.get("taskId"))
        .and_then(Value::as_str)?
        .to_string();
    let status = patch.get("status").or_else(|| value.get("status")).and_then(Value::as_str).map(claude_task_status);
    let usage_value = value.get("usage").or_else(|| patch.get("usage"));
    let backgrounded = patch
        .get("is_backgrounded")
        .or_else(|| patch.get("isBackgrounded"))
        .or_else(|| value.get("is_backgrounded"))
        .or_else(|| value.get("isBackgrounded"))
        .and_then(Value::as_bool);
    Some(DriverRuntimeTaskUpdate {
        id,
        status,
        detail: value
            .get("summary")
            .or_else(|| value.get("description"))
            .or_else(|| patch.get("summary"))
            .and_then(Value::as_str)
            .map(str::to_string),
        backgrounded,
        last_tool_name: value
            .get("last_tool_name")
            .or_else(|| value.get("lastToolName"))
            .or_else(|| patch.get("last_tool_name"))
            .or_else(|| patch.get("lastToolName"))
            .and_then(Value::as_str)
            .map(str::to_string),
        usage: claude_task_usage(usage_value),
        stats: usage_value.map(|usage| claude_task_stats(Some(usage))),
        capabilities: (backgrounded == Some(true))
            .then_some(RuntimeTaskCapabilities { stop: status.is_none_or(RuntimeTaskStatus::is_active), background: false }),
    })
}

fn claude_task_status(status: &str) -> RuntimeTaskStatus {
    match status {
        "pending" => RuntimeTaskStatus::Pending,
        "paused" | "waiting" => RuntimeTaskStatus::Waiting,
        "completed" | "done" | "success" => RuntimeTaskStatus::Completed,
        "failed" | "error" => RuntimeTaskStatus::Failed,
        "killed" | "stopped" | "cancelled" | "canceled" => RuntimeTaskStatus::Stopped,
        "interrupted" => RuntimeTaskStatus::Interrupted,
        _ => RuntimeTaskStatus::Running,
    }
}

fn claude_task_usage(value: Option<&Value>) -> Option<Usage> {
    let value = value?;
    let usage = parse_usage(value);
    (usage != Usage::default()).then_some(usage)
}

fn claude_task_stats(value: Option<&Value>) -> RuntimeTaskStats {
    let Some(value) = value else { return RuntimeTaskStats::default() };
    RuntimeTaskStats {
        token_count: value.get("total_tokens").or_else(|| value.get("totalTokens")).and_then(Value::as_u64),
        tool_uses: value.get("tool_uses").or_else(|| value.get("toolUses")).and_then(Value::as_u64),
        duration_ms: value.get("duration_ms").or_else(|| value.get("durationMs")).and_then(Value::as_u64),
        cpu_percent: None,
        rss_kb: None,
    }
}

fn content_blocks(message: &UserMessage) -> Vec<Value> {
    let Some(last_skill) = message.parts.iter().rposition(|part| matches!(part, ContentPart::Skill { .. })) else {
        return message.parts.iter().filter_map(claude_block).collect();
    };

    let mut blocks = Vec::new();
    for part in &message.parts[..last_skill] {
        if let Some(block) = match part {
            // Claude expands only one leading slash command. Earlier selected
            // skills remain explicit context for the model to invoke itself.
            ContentPart::Skill { name, .. } => Some(json!({ "type": "text", "text": format!("/{name}") })),
            _ => claude_block(part),
        } {
            blocks.push(block);
        }
    }

    let ContentPart::Skill { name, .. } = &message.parts[last_skill] else { unreachable!() };
    let mut trailing = String::new();
    let mut trailing_media = Vec::new();
    for part in &message.parts[last_skill + 1..] {
        match part {
            ContentPart::Text { text } => trailing.push_str(text),
            ContentPart::FileMention { path } => {
                trailing.push('@');
                trailing.push_str(path);
            }
            ContentPart::Attachment { name, .. } => {
                trailing.push_str(&format!("\n[attached file: {name}]"));
            }
            ContentPart::Mention { name, .. } => {
                trailing.push('@');
                trailing.push_str(name);
            }
            ContentPart::Image { .. } => {
                if let Some(block) = claude_block(part) {
                    trailing_media.push(block);
                }
            }
            ContentPart::Skill { .. } => unreachable!(),
        }
    }
    // Claude Code only expands a slash command at the start of the last text
    // block. Media can precede it, so keep uploads while making invocation
    // deterministic.
    blocks.extend(trailing_media);
    blocks.push(json!({ "type": "text", "text": format!("/{name}{trailing}").trim_end() }));
    blocks
}

fn claude_block(part: &ContentPart) -> Option<Value> {
    match part {
        ContentPart::Text { text } => Some(json!({ "type": "text", "text": text })),
        ContentPart::FileMention { path } => Some(json!({ "type": "text", "text": format!("@{path}") })),
        ContentPart::Skill { name, .. } => Some(json!({ "type": "text", "text": format!("${name}") })),
        ContentPart::Mention { name, .. } => Some(json!({ "type": "text", "text": format!("@{name}") })),
        ContentPart::Image { media_type, data } => {
            // Validate base64 so a bad upload fails here instead of as an API error mid-turn.
            base64::engine::general_purpose::STANDARD
                .decode(data)
                .is_ok()
                .then(|| json!({ "type": "image", "source": { "type": "base64", "media_type": media_type, "data": data } }))
        }
        ContentPart::Attachment { name, .. } => Some(json!({ "type": "text", "text": format!("[attached file: {name}]") })),
    }
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

    async fn set_effort(&self, _effort: &str) -> Result<()> {
        Err(DriverError::Unsupported("Claude Code effort is fixed when the session starts; start a new thread to change it".into()))
    }

    async fn respond_permission(&self, request_id: &str, decision: &ApprovalDecision) -> Result<()> {
        let Some((mut input, suggestions)) = self.0.pending_permissions.lock().await.get(request_id).cloned() else {
            return Err(DriverError::Protocol(format!("no pending permission request {request_id}")));
        };
        if input.get("_kybern_dialog").is_some() {
            let response = match decision {
                ApprovalDecision::Submit { response } => {
                    let result = match response.get("value").and_then(Value::as_str) {
                        Some("Compact and continue") => "compact",
                        Some("Keep full history") => "continue",
                        Some("Keep full history and skip future prompts") => "never",
                        _ => return Err(DriverError::Protocol("choose a resume option".into())),
                    };
                    json!({ "behavior": "completed", "result": result })
                }
                ApprovalDecision::Deny { .. } => json!({ "behavior": "cancelled" }),
                _ => return Err(DriverError::Protocol("this dialog needs an answer".into())),
            };
            self.0.respond_control(request_id, Ok(response)).await?;
            self.0.pending_permissions.lock().await.remove(request_id);
            return Ok(());
        }
        if input.get("_kybern_elicitation").is_some() {
            let response = match decision {
                ApprovalDecision::Submit { response } => response.clone(),
                ApprovalDecision::Deny { .. } => json!({ "action": "decline" }),
                _ => return Err(DriverError::Protocol("this form needs an answer".into())),
            };
            self.0.respond_control(request_id, Ok(response)).await?;
            self.0.pending_permissions.lock().await.remove(request_id);
            return Ok(());
        }
        let response = match decision {
            ApprovalDecision::Submit { response } => {
                input["answers"] = response.get("answers").cloned().ok_or_else(|| DriverError::Protocol("missing answers".into()))?;
                json!({ "behavior": "allow", "updatedInput": input })
            }
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
        self.0.respond_control(request_id, Ok(response)).await?;
        self.0.pending_permissions.lock().await.remove(request_id);
        Ok(())
    }

    async fn stop_runtime_task(&self, task: &RuntimeTask) -> Result<()> {
        self.0.send_control("stop_task", json!({ "task_id": task.id })).await.map(|_| ())
    }

    async fn background_runtime_task(&self, task: &RuntimeTask) -> Result<()> {
        let tool_use_id = task
            .tool_call_id
            .as_deref()
            .ok_or_else(|| DriverError::Unsupported("Claude Code did not expose the tool id needed to background this task".into()))?;
        self.0.send_control("background_tasks", json!({ "tool_use_id": tool_use_id })).await.map(|_| ())
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
    async fn questions_and_elicitation_keep_native_response_shapes() {
        use super::*;
        let child = Arc::new(NdjsonChild::spawn(Command::new("cat")).unwrap());
        let (events, mut rx) = mpsc::channel(8);
        let session = Arc::new(ClaudeSession {
            child: child.clone(),
            events,
            pending_control: Mutex::new(HashMap::new()),
            pending_permissions: Mutex::new(HashMap::new()),
            state: Mutex::new(TurnState::default()),
            session_id: Mutex::new("test".into()),
        });
        let handle = SessionHandle(session.clone());
        let questions = json!([{ "question": "Which sections?", "options": [{"label":"Intro"},{"label":"Summary"}], "multiSelect": true }]);
        session.handle_control_request(&json!({ "request_id": "question", "request": { "subtype": "can_use_tool", "tool_name": "AskUserQuestion", "input": { "questions": questions } } })).await;
        assert!(matches!(rx.recv().await, Some(DriverEvent::PermissionRequest { tool_name, .. }) if tool_name == "AskUserQuestion"));
        handle
            .respond_permission(
                "question",
                &ApprovalDecision::Submit { response: json!({ "answers": { "Which sections?": "Intro, Summary" } }) },
            )
            .await
            .unwrap();
        let response = tokio::time::timeout(std::time::Duration::from_secs(1), async { child.lines.lock().await.recv().await.unwrap() })
            .await
            .unwrap();
        assert_eq!(
            response["response"]["response"]["updatedInput"],
            json!({ "questions": questions, "answers": { "Which sections?": "Intro, Summary" } })
        );
        session.handle_control_request(&json!({ "request_id": "form", "request": { "subtype": "elicitation", "message": "Name", "requestedSchema": { "type": "object" } } })).await;
        assert!(matches!(rx.recv().await, Some(DriverEvent::PermissionRequest { tool_name, .. }) if tool_name == "mcp_elicitation"));
        handle
            .respond_permission("form", &ApprovalDecision::Submit { response: json!({ "action": "accept", "content": { "name": "Ada" } }) })
            .await
            .unwrap();
        let response = tokio::time::timeout(std::time::Duration::from_secs(1), async { child.lines.lock().await.recv().await.unwrap() })
            .await
            .unwrap();
        assert_eq!(response["response"]["response"], json!({ "action": "accept", "content": { "name": "Ada" } }));
        for (choice, expected) in
            [("Compact and continue", "compact"), ("Keep full history", "continue"), ("Keep full history and skip future prompts", "never")]
        {
            session.handle_control_request(&json!({ "request_id": "resume", "request": { "subtype": "request_user_dialog", "dialog_kind": "resume_return", "payload": {} } })).await;
            assert!(matches!(rx.recv().await, Some(DriverEvent::PermissionRequest { tool_name, .. }) if tool_name == "ui_select"));
            handle.respond_permission("resume", &ApprovalDecision::Submit { response: json!({ "value": choice }) }).await.unwrap();
            let response =
                tokio::time::timeout(std::time::Duration::from_secs(1), async { child.lines.lock().await.recv().await.unwrap() })
                    .await
                    .unwrap();
            assert_eq!(response["response"]["response"], json!({ "behavior": "completed", "result": expected }));
        }
        child.kill().await;
    }
    use super::{claude_background_task, claude_efforts, claude_model_aliases, claude_task_started, claude_task_update, content_blocks};
    use kybern_protocol::{ContentPart, RuntimeTaskKind, RuntimeTaskStatus, UserMessage};
    use serde_json::json;

    const HELP: &str = "\
  --effort <level>  Effort level for the current session\n\
                    (low, medium, high, xhigh, max)\n\
  --environment <environment_id>  Create a cloud session\n\
  --model <model>  Model for the current session. Provide an alias for the latest model\n\
                   (e.g. 'fable', 'opus', or 'sonnet') or a model's full name\n\
                   (e.g. 'claude-fable-5').\n";

    #[test]
    fn parses_capabilities_reported_by_help() {
        assert_eq!(claude_model_aliases(HELP), ["fable", "opus", "sonnet"]);
        assert_eq!(claude_efforts(HELP), ["low", "medium", "high", "xhigh", "max"]);
    }

    #[test]
    fn dispatches_the_last_selected_skill_as_claudes_slash_command() {
        let message = UserMessage {
            parts: vec![
                ContentPart::Text { text: "First use ".into() },
                ContentPart::Skill { name: "review".into(), path: "/skills/review/SKILL.md".into() },
                ContentPart::Text { text: ", then ".into() },
                ContentPart::Skill { name: "fix-ci".into(), path: "/skills/fix-ci/SKILL.md".into() },
                ContentPart::Text { text: " carefully".into() },
            ],
        };
        assert_eq!(
            content_blocks(&message),
            vec![
                json!({ "type": "text", "text": "First use " }),
                json!({ "type": "text", "text": "/review" }),
                json!({ "type": "text", "text": ", then " }),
                json!({ "type": "text", "text": "/fix-ci carefully" }),
            ]
        );
    }

    #[test]
    fn parses_native_task_lifecycle_and_capabilities() {
        let task = claude_task_started(&json!({
            "task_id": "agent-7",
            "task_type": "local_agent",
            "description": "Inspect the daemon",
            "tool_use_id": "tool-2",
            "status": "running",
            "usage": { "total_tokens": 1200, "tool_uses": 4, "duration_ms": 3200 }
        }))
        .unwrap();
        assert_eq!(task.kind, RuntimeTaskKind::Agent);
        assert_eq!(task.status, RuntimeTaskStatus::Running);
        assert_eq!(task.title, "Inspect the daemon");
        assert!(task.capabilities.stop);
        assert!(task.capabilities.background);
        assert_eq!(task.stats.token_count, Some(1200));

        let update = claude_task_update(&json!({
            "taskId": "agent-7",
            "patch": { "isBackgrounded": true, "status": "waiting" },
            "summary": "Waiting for results"
        }))
        .unwrap();
        assert_eq!(update.status, Some(RuntimeTaskStatus::Waiting));
        assert_eq!(update.backgrounded, Some(true));
        assert_eq!(update.detail.as_deref(), Some("Waiting for results"));
        assert!(!update.capabilities.unwrap().background);

        let background = claude_background_task(&json!({
            "task_id": "shell-4",
            "task_type": "local_bash",
            "description": "pnpm dev"
        }))
        .unwrap();
        assert!(background.backgrounded);
        assert!(!background.capabilities.background);
    }
}
