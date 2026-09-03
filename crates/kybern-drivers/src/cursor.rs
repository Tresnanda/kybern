//! Cursor driver: drives `agent acp` over the Agent Client Protocol using the
//! `agent-client-protocol` crate.
//!
//! Cursor runs its own tools in-process (it never calls the client's fs or
//! terminal methods), does not report token usage, and has no session fork,
//! so rewinds are workspace-only. Sessions persist under ~/.cursor and reload
//! with `session/load`, which replays history as notifications we ignore.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;

use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::schema::v1::{
    AuthenticateRequest, CancelNotification, ClientCapabilities, ContentBlock, ImageContent, Implementation, InitializeRequest,
    LoadSessionRequest, NewSessionRequest, PromptRequest, RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
    SelectedPermissionOutcome, SessionNotification, SessionUpdate, SetSessionConfigOptionRequest, SetSessionModeRequest,
    StopReason as AcpStop, TextContent, ToolCallContent,
};
use agent_client_protocol::{
    Agent, ByteStreams, Client, ConnectionTo, JsonRpcRequest, JsonRpcResponse, on_receive_notification, on_receive_request,
};
use async_trait::async_trait;
use kybern_protocol::*;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::process::Command;
use tokio::sync::{Mutex, mpsc, oneshot};
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

use crate::binary::{resolve, version_of};
use crate::{AgentDriver, AgentSession, DriverError, DriverEvent, ProbeContext, Result, SessionConfig, SpawnedSession};

#[derive(Default)]
pub struct CursorDriver;

const MODEL_DISCOVERY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

fn parse_cursor_models(output: &[u8]) -> Vec<ProviderModel> {
    String::from_utf8_lossy(output)
        .lines()
        .filter_map(|line| {
            let (id, label) = line.trim().split_once(" - ")?;
            if id.is_empty() || label.is_empty() {
                return None;
            }
            let is_default = label.ends_with(" (default)");
            let display_name = label.strip_suffix(" (default)").unwrap_or(label).to_string();
            Some(ProviderModel { id: id.to_string(), display_name, provider: None, efforts: Vec::new(), default_effort: None, is_default })
        })
        .collect()
}

async fn cursor_models(bin: &std::path::Path, context: &ProbeContext) -> Vec<ProviderModel> {
    let mut command = Command::new(bin);
    command.args(["models"]).stdin(Stdio::null()).kill_on_drop(true).env("NO_COLOR", "1");
    if let Some(cwd) = &context.cwd {
        command.current_dir(cwd);
    }
    for (key, value) in &context.env {
        command.env(key, value);
    }
    match tokio::time::timeout(MODEL_DISCOVERY_TIMEOUT, command.output()).await {
        Ok(Ok(output)) if output.status.success() => parse_cursor_models(&output.stdout),
        _ => Vec::new(),
    }
}

impl CursorDriver {
    async fn probe_inner(&self, context: &ProbeContext) -> ProviderStatus {
        let mut status = ProviderStatus {
            kind: ProviderKind::Cursor,
            display_name: ProviderKind::Cursor.display_name().into(),
            available: false,
            binary_path: None,
            version: None,
            unavailable_reason: None,
            // Cursor's ACP mode decides approvals itself; we map modes onto agent/plan/ask.
            supported_permission_modes: vec![PermissionMode::Supervised, PermissionMode::Auto, PermissionMode::FullAccess],
            supports_fork: false,
            supports_model_switch: true,
            supports_effort_switch: false,
            supported_efforts: vec![],
            models: vec![],
            instances: vec!["default".into()],
        };
        let bin = match resolve(ProviderKind::Cursor, context.binary.as_ref()) {
            Ok(bin) => bin,
            Err(error) => {
                status.unavailable_reason = Some(format!("{error}. Install with: curl https://cursor.com/install -fsS | bash"));
                return status;
            }
        };
        status.binary_path = Some(bin.display().to_string());
        match version_of(&bin, &["--version"]).await {
            Some(version) => {
                status.available = true;
                status.version = Some(version);
                status.models = cursor_models(&bin, context).await;
            }
            None => status.unavailable_reason = Some("could not run `agent --version`".into()),
        }
        status
    }
}

#[cfg(test)]
mod model_catalog_tests {
    use super::parse_cursor_models;

    #[test]
    fn parses_cursor_account_models_and_default() {
        let models = parse_cursor_models(
            b"Available models\n\nauto - Auto (default)\ngpt-5.4-high - GPT-5.4 1M High\n\nTip: use --model <id> to switch.\n",
        );

        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "auto");
        assert_eq!(models[0].display_name, "Auto");
        assert!(models[0].is_default);
        assert_eq!(models[1].id, "gpt-5.4-high");
        assert!(!models[1].is_default);
    }
}

/// Cursor extension: the agent asks the user a question.
#[derive(Debug, Clone, Serialize, Deserialize, JsonRpcRequest)]
#[request(method = "cursor/ask_question", response = CursorAskQuestionResponse)]
#[serde(rename_all = "camelCase")]
struct CursorAskQuestionRequest {
    tool_call_id: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    questions: Vec<Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonRpcResponse)]
struct CursorAskQuestionResponse {
    outcome: Value,
}

/// Cursor extension: the agent proposes a plan.
#[derive(Debug, Clone, Serialize, Deserialize, JsonRpcRequest)]
#[request(method = "cursor/create_plan", response = CursorCreatePlanResponse)]
#[serde(rename_all = "camelCase")]
struct CursorCreatePlanRequest {
    tool_call_id: String,
    #[serde(default)]
    plan: Option<String>,
    #[serde(default)]
    todos: Vec<Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonRpcResponse)]
struct CursorCreatePlanResponse {
    outcome: Value,
}

#[async_trait]
impl AgentDriver for CursorDriver {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Cursor
    }

    fn supports_fork(&self) -> bool {
        false
    }

    async fn probe(&self, binary: Option<&PathBuf>) -> ProviderStatus {
        self.probe_inner(&ProbeContext { binary: binary.cloned(), ..ProbeContext::default() }).await
    }

    async fn probe_with_context(&self, context: &ProbeContext) -> ProviderStatus {
        self.probe_inner(context).await
    }

    async fn spawn(&self, config: SessionConfig) -> Result<SpawnedSession> {
        let bin = resolve(ProviderKind::Cursor, config.binary.as_ref())?;
        let (events_tx, events_rx) = mpsc::channel(1024);
        let (cmd_tx, cmd_rx) = mpsc::channel::<SessionCommand>(64);
        let (bound_tx, bound_rx) = oneshot::channel::<Result<String>>();

        let shared = Arc::new(Shared {
            events: events_tx.clone(),
            pending: Mutex::new(std::collections::HashMap::new()),
            mode: config.permission_mode,
        });
        let worker_shared = shared.clone();
        let cfg = config.clone();
        tokio::spawn(async move {
            let outcome = run_connection(bin, cfg, worker_shared, cmd_rx, bound_tx).await;
            let error = outcome.err().map(|e| e.to_string());
            let _ = events_tx.send(DriverEvent::Exited { code: None, error }).await;
        });

        match bound_rx.await {
            Ok(Ok(_)) => {}
            Ok(Err(e)) => return Err(e),
            Err(_) => return Err(DriverError::ProcessExited("cursor agent exited during startup".into())),
        }
        Ok(SpawnedSession { session: Box::new(Handle { commands: cmd_tx, shared }), events: events_rx })
    }
}

struct Shared {
    events: mpsc::Sender<DriverEvent>,
    /// Pending permission requests: request id -> responder sender with the chosen option id.
    pending: Mutex<std::collections::HashMap<String, oneshot::Sender<Option<String>>>>,
    mode: PermissionMode,
}

enum SessionCommand {
    Prompt { blocks: Vec<ContentBlock> },
    Cancel,
    SetModel(String, oneshot::Sender<Result<()>>),
    SetMode(PermissionMode, oneshot::Sender<Result<()>>),
    Close,
}

struct Handle {
    commands: mpsc::Sender<SessionCommand>,
    shared: Arc<Shared>,
}

fn mode_id(mode: PermissionMode) -> &'static str {
    match mode {
        PermissionMode::Supervised | PermissionMode::AcceptEdits => "agent",
        PermissionMode::Auto | PermissionMode::FullAccess => "agent",
    }
}

/// The whole ACP connection lives inside `connect_with`; commands arrive over a channel.
async fn run_connection(
    bin: PathBuf,
    config: SessionConfig,
    shared: Arc<Shared>,
    mut commands: mpsc::Receiver<SessionCommand>,
    bound: oneshot::Sender<Result<String>>,
) -> Result<()> {
    // Spawn ourselves so the process cwd is the project (Cursor reads .cursor/mcp.json from it).
    let mut cmd = Command::new(&bin);
    cmd.arg("acp")
        .current_dir(&config.cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    for (k, v) in &config.env {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn()?;
    let stdin = child.stdin.take().ok_or_else(|| DriverError::Protocol("no stdin".into()))?;
    let stdout = child.stdout.take().ok_or_else(|| DriverError::Protocol("no stdout".into()))?;
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            use tokio::io::AsyncBufReadExt;
            let mut lines = tokio::io::BufReader::new(stderr).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                tracing::debug!(target: "provider.stderr", "{l}");
            }
        });
    }
    let agent = ByteStreams::new(stdin.compat_write(), stdout.compat());
    let _child_guard = child; // killed on drop when the connection ends
    let cwd = config.cwd.clone();
    let events = shared.events.clone();
    let shared_perm = shared.clone();
    let shared_tools = shared.clone();
    let mut bound = Some(bound);

    // Message ids are synthetic: one per contiguous run of agent chunks.
    let msg_state: Arc<Mutex<(u64, bool)>> = Arc::new(Mutex::new((0, false)));
    let msg_state_notif = msg_state.clone();
    let loading = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let loading_notif = loading.clone();

    let result = Client
        .builder()
        .name("kybern")
        .on_receive_notification(
            async move |n: SessionNotification, _cx| {
                if loading_notif.load(std::sync::atomic::Ordering::Relaxed) {
                    return Ok(());
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
                            let _ = ev.send(DriverEvent::TextDelta { message_id: id, delta: t.text }).await;
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
                            let _ = ev.send(DriverEvent::ThinkingDelta { message_id: id, delta: t.text }).await;
                        }
                    }
                    SessionUpdate::ToolCall(tc) => {
                        // A tool call ends the current assistant message run.
                        msg_state_notif.lock().await.1 = false;
                        let _ = ev
                            .send(DriverEvent::ToolStarted(ToolCall {
                                id: tc.tool_call_id.to_string(),
                                name: format!("{:?}", tc.kind).to_lowercase(),
                                input: json!({ "title": tc.title, "raw": tc.raw_input }),
                                parent_id: None,
                            }))
                            .await;
                    }
                    SessionUpdate::ToolCallUpdate(u) => {
                        let status = u.fields.status.map(|s| format!("{s:?}").to_lowercase());
                        if matches!(status.as_deref(), Some("completed") | Some("failed")) {
                            let mut diffs = Vec::new();
                            for c in u.fields.content.iter().flatten() {
                                if let ToolCallContent::Diff(d) = c {
                                    diffs.push(json!({ "path": d.path, "old": d.old_text, "new": d.new_text }));
                                }
                            }
                            let _ = ev
                                .send(DriverEvent::ToolCompleted {
                                    tool_call_id: u.tool_call_id.to_string(),
                                    output: json!({ "raw": u.fields.raw_output, "diffs": diffs, "title": u.fields.title }),
                                    is_error: status.as_deref() == Some("failed"),
                                })
                                .await;
                        }
                    }
                    SessionUpdate::Plan(p) => {
                        let _ = ev.send(DriverEvent::Notice { level: NoticeLevel::Info, text: format!("plan updated ({} entries)", p.entries.len()), data: serde_json::to_value(&p).ok() }).await;
                    }
                    SessionUpdate::UsageUpdate(u) => {
                        let _ = ev.send(DriverEvent::Notice { level: NoticeLevel::Info, text: format!("context {}/{}", u.used, u.size), data: serde_json::to_value(&u).ok() }).await;
                    }
                    _ => {}
                }
                Ok(())
            },
            on_receive_notification!(),
        )
        .on_receive_request(
            async move |req: RequestPermissionRequest, responder, _cx| {
                let shared = shared_perm.clone();
                let request_id = uuid::Uuid::new_v4().simple().to_string();
                let (tx, rx) = oneshot::channel();
                shared.pending.lock().await.insert(request_id.clone(), tx);
                let title = req.tool_call.fields.title.clone().unwrap_or_default();
                let allow_all = matches!(shared.mode, PermissionMode::Auto | PermissionMode::FullAccess);
                let options: Vec<Value> = req.options.iter().map(|o| json!({ "id": o.option_id.to_string(), "name": o.name, "kind": format!("{:?}", o.kind) })).collect();
                let pick = |prefix: &str| req.options.iter().find(|o| format!("{:?}", o.kind).to_lowercase().starts_with(prefix)).map(|o| o.option_id.clone());
                if allow_all {
                    let choice = pick("allowalways").or_else(|| pick("allowonce")).or_else(|| req.options.first().map(|o| o.option_id.clone()));
                    return responder.respond(RequestPermissionResponse::new(match choice {
                        Some(id) => RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(id)),
                        None => RequestPermissionOutcome::Cancelled,
                    }));
                }
                let _ = shared
                    .events
                    .send(DriverEvent::PermissionRequest {
                        request_id,
                        tool_call_id: Some(req.tool_call.tool_call_id.to_string()),
                        tool_name: req.tool_call.fields.kind.map(|k| format!("{k:?}").to_lowercase()).unwrap_or_else(|| "tool".into()),
                        input: json!({ "title": title, "raw": req.tool_call.fields.raw_input, "options": options }),
                        summary: title.clone(),
                        suggestions: vec![],
                    })
                    .await;
                let decision = rx.await.ok().flatten();
                let outcome = match decision.as_deref() {
                    Some("allow_once") => pick("allowonce").or_else(|| pick("allowalways")),
                    Some("allow_always") => pick("allowalways").or_else(|| pick("allowonce")),
                    Some(_) | None => pick("rejectonce").or_else(|| pick("rejectalways")),
                };
                responder.respond(RequestPermissionResponse::new(match outcome {
                    Some(id) => RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(id)),
                    None => RequestPermissionOutcome::Cancelled,
                }))
            },
            on_receive_request!(),
        )
        .on_receive_request(
            async move |req: CursorAskQuestionRequest, responder, _cx| {
                let _ = shared_tools
                    .events
                    .send(DriverEvent::Notice { level: NoticeLevel::Warning, text: "Cursor asked a question kybern cannot relay yet".into(), data: Some(json!({ "title": req.title, "questions": req.questions })) })
                    .await;
                responder.respond(CursorAskQuestionResponse { outcome: json!({ "outcome": "skipped", "reason": "not supported by client" }) })
            },
            on_receive_request!(),
        )
        .on_receive_request(
            async move |req: CursorCreatePlanRequest, responder, _cx| {
                let _ = req;
                responder.respond(CursorCreatePlanResponse { outcome: json!({ "outcome": "accepted" }) })
            },
            on_receive_request!(),
        )
        .connect_with(agent, async |cx: ConnectionTo<Agent>| {
            let init = cx
                .send_request(InitializeRequest::new(ProtocolVersion::V1).client_capabilities(ClientCapabilities::new()).client_info(Implementation::new("kybern", env!("CARGO_PKG_VERSION"))))
                .block_task()
                .await?;
            if init.auth_methods.iter().any(|m| m.id().to_string() == "cursor_login") {
                let _ = cx.send_request(AuthenticateRequest::new("cursor_login")).block_task().await;
            }

            let session_id = match &config.resume_session_id {
                Some(id) => {
                    loading.store(true, std::sync::atomic::Ordering::Relaxed);
                    let r = cx.send_request(LoadSessionRequest::new(id.clone(), cwd.clone())).block_task().await;
                    loading.store(false, std::sync::atomic::Ordering::Relaxed);
                    match r {
                        Ok(_) => agent_client_protocol::schema::v1::SessionId::from(id.clone()),
                        Err(_) => cx.send_request(NewSessionRequest::new(cwd.clone())).block_task().await?.session_id,
                    }
                }
                None => cx.send_request(NewSessionRequest::new(cwd.clone())).block_task().await?.session_id,
            };
            let _ = cx.send_request(SetSessionModeRequest::new(session_id.clone(), mode_id(config.permission_mode))).block_task().await;
            if let Some(model) = &config.model {
                let _ = cx.send_request(SetSessionConfigOptionRequest::new(session_id.clone(), "model", model.as_str())).block_task().await;
            }
            if let Some(b) = bound.take() {
                let _ = b.send(Ok(session_id.to_string()));
            }
            let _ = shared.events.send(DriverEvent::SessionBound { session_id: session_id.to_string(), model: config.model.clone() }).await;

            while let Some(cmd) = commands.recv().await {
                match cmd {
                    SessionCommand::Prompt { blocks } => {
                        let started = std::time::Instant::now();
                        msg_state.lock().await.1 = false;
                        let cx2 = cx.clone();
                        let sid = session_id.clone();
                        let prompt = cx2.send_request(PromptRequest::new(sid, blocks));
                        // Allow cancel while the prompt is in flight.
                        let mut fut = std::pin::pin!(prompt.block_task());
                        let resp = loop {
                            tokio::select! {
                                r = &mut fut => break r,
                                c = commands.recv() => match c {
                                    Some(SessionCommand::Cancel) => { let _ = cx.send_notification(CancelNotification::new(session_id.clone())); }
                                    Some(SessionCommand::Close) | None => { let _ = cx.send_notification(CancelNotification::new(session_id.clone())); }
                                    Some(SessionCommand::SetModel(_, tx)) => { let _ = tx.send(Err(DriverError::Protocol("busy".into()))); }
                                    Some(SessionCommand::SetMode(_, tx)) => { let _ = tx.send(Err(DriverError::Protocol("busy".into()))); }
                                    Some(SessionCommand::Prompt { .. }) => {}
                                },
                            }
                        };
                        let duration_ms = started.elapsed().as_millis() as u64;
                        let ev = match resp {
                            Ok(r) => {
                                // Cursor reports no token usage over ACP.
                                let usage = Usage::default();
                                let stop = match r.stop_reason {
                                    AcpStop::EndTurn => StopReason::Completed,
                                    AcpStop::Cancelled => StopReason::Interrupted,
                                    AcpStop::MaxTokens | AcpStop::MaxTurnRequests => StopReason::MaxTurns,
                                    AcpStop::Refusal => StopReason::Completed,
                                    _ => StopReason::Completed,
                                };
                                DriverEvent::TurnCompleted { stop_reason: stop, usage, cost_usd: None, duration_ms, anchors: crate::TurnAnchors::default() }
                            }
                            Err(e) => DriverEvent::TurnFailed { error: e.to_string() },
                        };
                        let _ = shared.events.send(ev).await;
                    }
                    SessionCommand::Cancel => {
                        let _ = cx.send_notification(CancelNotification::new(session_id.clone()));
                    }
                    SessionCommand::SetModel(model, tx) => {
                        let r = cx.send_request(SetSessionConfigOptionRequest::new(session_id.clone(), "model", model.as_str())).block_task().await;
                        let _ = tx.send(r.map(|_| ()).map_err(|e| DriverError::Protocol(e.to_string())));
                    }
                    SessionCommand::SetMode(mode, tx) => {
                        let r = cx.send_request(SetSessionModeRequest::new(session_id.clone(), mode_id(mode))).block_task().await;
                        let _ = tx.send(r.map(|_| ()).map_err(|e| DriverError::Protocol(e.to_string())));
                    }
                    SessionCommand::Close => break,
                }
            }
            Ok(())
        })
        .await;
    result.map_err(|e| DriverError::Protocol(format!("cursor acp: {e}")))
}

fn blocks(message: &UserMessage) -> Vec<ContentBlock> {
    let mut out = Vec::new();
    for part in &message.parts {
        match part {
            ContentPart::Text { text } => out.push(ContentBlock::Text(TextContent::new(text.clone()))),
            ContentPart::FileMention { path } => out.push(ContentBlock::Text(TextContent::new(format!("@{path}")))),
            ContentPart::Skill { name, .. } => out.push(ContentBlock::Text(TextContent::new(format!("/{name}")))),
            ContentPart::Image { media_type, data } => out.push(ContentBlock::Image(ImageContent::new(data.clone(), media_type.clone()))),
            ContentPart::Attachment { name, .. } => out.push(ContentBlock::Text(TextContent::new(format!("[attached file: {name}]")))),
        }
    }
    out
}

#[async_trait]
impl AgentSession for Handle {
    async fn send_message(&self, _message_id: &str, message: &UserMessage) -> Result<()> {
        self.commands
            .send(SessionCommand::Prompt { blocks: blocks(message) })
            .await
            .map_err(|_| DriverError::ProcessExited("cursor session closed".into()))
    }

    async fn interrupt(&self) -> Result<()> {
        self.commands.send(SessionCommand::Cancel).await.map_err(|_| DriverError::ProcessExited("cursor session closed".into()))
    }

    async fn set_permission_mode(&self, mode: PermissionMode) -> Result<()> {
        let (tx, rx) = oneshot::channel();
        self.commands
            .send(SessionCommand::SetMode(mode, tx))
            .await
            .map_err(|_| DriverError::ProcessExited("cursor session closed".into()))?;
        rx.await.map_err(|_| DriverError::ProcessExited("cursor session closed".into()))?
    }

    async fn set_model(&self, model: &str) -> Result<()> {
        let (tx, rx) = oneshot::channel();
        self.commands
            .send(SessionCommand::SetModel(model.to_string(), tx))
            .await
            .map_err(|_| DriverError::ProcessExited("cursor session closed".into()))?;
        rx.await.map_err(|_| DriverError::ProcessExited("cursor session closed".into()))?
    }

    async fn set_effort(&self, _effort: &str) -> Result<()> {
        Err(DriverError::Unsupported("Cursor ACP did not advertise an effort control".into()))
    }

    async fn respond_permission(&self, request_id: &str, decision: &ApprovalDecision) -> Result<()> {
        let Some(tx) = self.shared.pending.lock().await.remove(request_id) else {
            return Err(DriverError::Protocol(format!("no pending approval {request_id}")));
        };
        let choice = match decision {
            ApprovalDecision::AllowOnce => "allow_once",
            ApprovalDecision::AllowAlways => "allow_always",
            ApprovalDecision::Deny { .. } => "reject",
        };
        let _ = tx.send(Some(choice.to_string()));
        Ok(())
    }

    async fn close(&self) -> Result<()> {
        let _ = self.commands.send(SessionCommand::Close).await;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::blocks;
    use agent_client_protocol::schema::v1::ContentBlock;
    use kybern_protocol::{ContentPart, UserMessage};

    #[test]
    fn cursor_uses_its_native_skill_command_syntax() {
        let message = UserMessage { parts: vec![ContentPart::Skill { name: "review".into(), path: "/skills/review/SKILL.md".into() }] };

        let blocks = blocks(&message);
        let ContentBlock::Text(text) = &blocks[0] else { panic!("expected text block") };
        assert_eq!(text.text, "/review");
    }
}
