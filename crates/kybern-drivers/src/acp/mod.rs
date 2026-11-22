//! One ACP (Agent Client Protocol) client for every harness that speaks it, on the official
//! `agent-client-protocol` crate. What differs per agent is an [`AcpFlavor`]: Grok Build
//! (`grok.rs`) and legacy Cursor chats (`cursor/acp.rs`) are flavors.
//!
//! The core owns the session's life: spawn and `initialize`, `session/new` or `session/load` (its
//! replay is history, hidden until the first prompt), the first mode and model, prompts and how they
//! settle (answer, the agent's own completion notice, a Stop the agent ignores, steering by the next
//! prompt), permission requests (Kybern's own answers, cards and the Accept edits path check), the
//! agent's extension requests as cards, session updates as driver events, and startup failures.
//!
//! - `startup`: the steps a start can fail at, stderr, and handing the failure to `spawn`'s caller.
//! - `turn`: commands to the worker, how a prompt settles, the replay wait.
//! - `permission`: Kybern's own answers, the Accept edits path check, option picking.
//! - `content`: prompt blocks and the guide, Kybern's MCP server, generic tool and command names.
//!
//! A new flavor implements `command` (binary, arguments per permission mode, environment such as an
//! account's data folder) and its startup errors, and overrides only what differs from plain ACP. An
//! agent that asks before acting in its `default` mode gets Kybern's own answers from `auto_permission`
//! (the Accept edits path check included) with `session_mode` and `POLICY_FOLLOWS_MODE`; one that steers
//! by the next prompt says so in `steers_with_prompt`; `EFFORT_OPTION` names its thinking option, and
//! `session_meta` carries what `session/new` and `session/load` need (an appended system prompt).

mod content;
mod permission;
mod startup;
mod turn;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::schema::v1::{
    AuthenticateRequest, CancelNotification, ClientCapabilities, ContentBlock, Implementation, InitializeRequest, InitializeResponse,
    LoadSessionRequest, McpServer, Meta, NewSessionRequest, PermissionOption, PromptRequest, RequestPermissionRequest,
    RequestPermissionResponse, SessionConfigOption, SessionConfigValueId, SessionId, SessionModeState, SessionNotification, SessionUpdate,
    SetSessionConfigOptionRequest, SetSessionModeRequest, ToolCall as AcpToolCall, ToolCallStatus, ToolCallUpdateFields, ToolKind,
};
use agent_client_protocol::{
    Agent, ByteStreams, Client, ConnectionTo, Handled, Responder, UntypedMessage, on_receive_notification, on_receive_request,
};
use async_trait::async_trait;
use kybern_protocol::*;
use serde_json::{Value, json};
use tokio::process::Command;
use tokio::sync::{Mutex, mpsc, oneshot};
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

use crate::binary::resolve;
use crate::{AgentSession, DriverError, DriverEvent, NativeToolBridge, Result, SessionConfig, SpawnedSession};

pub(crate) use content::{blocks_with_guide, command_update, mcp_servers, merge_text_blocks, option_list, prompt_blocks, tool_name};
pub(crate) use permission::{Ask, auto_response, cancelled, permission_response, selected};
pub(crate) use startup::{Startup, fail_startup, rejects_arguments, remember_stderr, stderr_text};
pub(crate) use turn::{Completion, LOAD_REPLAY_IDLE, LOAD_TIMEOUT, SessionCommand};
#[cfg(test)]
pub(crate) use {
    content::prompt_with_guide,
    startup::STDERR_TAIL_BYTES,
    turn::{CANCEL_GRACE, LoadOutcome, Settled, await_session_load, settle_prompt},
};
// Only the fake-agent session tests, which run on Unix, use these.
#[cfg(all(test, unix))]
pub(crate) use turn::{TEST_CANCEL_GRACE_MS, TEST_REPLAY_IDLE_MS};

/// A tool call as Kybern names it: the name, and the arguments when the call is really an MCP tool's.
pub(crate) struct ToolIdentity {
    pub(crate) name: String,
    /// Set when the agent ran an MCP tool through a built-in of its own: the MCP tool's own arguments.
    pub(crate) mcp_arguments: Option<Value>,
}

/// A permission card's contents. The core adds the request and tool call ids.
pub(crate) struct PermissionCard {
    pub(crate) tool_name: String,
    pub(crate) input: Value,
    pub(crate) summary: String,
}

/// The config option writes that select a model and effort, in order, and the model to report as in use.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ConfigSelection {
    pub(crate) writes: Vec<(String, String)>,
    /// The model reported in `SessionBound` (`None`: the agent's default).
    pub(crate) model: Option<String>,
}

/// An extension request (`x.ai/…`, `cursor/…`) the flavor handles.
pub(crate) enum Extension {
    /// Answered at once, without a card.
    Answer(Value),
    /// Shown to the user as a card; the agent gets the answer.
    Ask(Box<dyn ExtensionAsk>),
}

/// An extension request shown to the user. Questions and plans reach the user whatever the permission mode.
pub(crate) trait ExtensionAsk: Send + Sync + 'static {
    fn kind(&self) -> Ask;
    /// The card Kybern shows.
    fn card(&self, request_id: String) -> DriverEvent;
    /// The agent's response to the user's decision (`None`: the turn ended unanswered).
    fn response(&self, decision: Option<ApprovalDecision>) -> Value;
}

/// What differs between ACP agents. Everything but the process, its startup errors and the name has
/// a default that fits a plain ACP agent.
pub(crate) trait AcpFlavor: Send + Sync + Sized + 'static {
    /// The agent's own "this prompt is done" notice ([`std::convert::Infallible`] when it sends none).
    type Completion: Completion;

    const KIND: ProviderKind;
    /// The harness as people read it ("Grok Build").
    const NAME: &'static str;
    /// The error text once the session's worker is gone.
    const CLOSED: &'static str = "session closed";
    /// `interrupt` on a closed session is an error, not a no-op.
    const INTERRUPT_REPORTS_CLOSED: bool = false;
    /// How long `close` waits for the session to end before it stops it; `None` returns at once.
    const CLOSE_WAIT: Option<Duration> = None;
    /// The agent has no system channel: Kybern's guide rides on the first ordinary prompt.
    const CARRIES_GUIDE: bool = false;
    /// Show images the agent writes in its messages.
    const AGENT_IMAGES: bool = false;
    /// Kybern's own permission answers follow a live mode switch (else they keep the mode the session started in).
    const POLICY_FOLLOWS_MODE: bool = false;
    /// A steer the agent can't take goes back to the daemon as a follow-up (`SteerFallback`), not refused.
    const STEER_FALLBACK: bool = false;
    /// Quiet after a `session/load` replay chunk that counts the load as done, for an agent that can leave
    /// the load unanswered; `None` waits for the answer, however long, and hides the whole replay until then.
    const REPLAY_IDLE: Option<Duration>;
    /// The longest wait for `session/load`; `None` waits as long as the agent takes.
    const LOAD_TIMEOUT: Option<Duration>;
    /// The prompt that compacts the conversation, when the agent has one.
    const COMPACT: Option<&'static str> = None;
    /// Why the permission mode can't change during a session, when [`AcpFlavor::session_mode`] has no mode for it.
    const NO_MODE_SWITCH: &'static str = "This harness can't change its permission mode during a session";
    /// Why the model can't change during a session (else `session/set_config_option` "model" switches it).
    const NO_MODEL_SWITCH: Option<&'static str> = None;
    /// The config option that sets the reasoning effort (also at session start), and why there is none.
    const EFFORT_OPTION: Option<&'static str> = None;
    const NO_EFFORT_SWITCH: &'static str = "This harness does not expose effort switching over ACP";
    /// A model that couldn't be set is still reported as the one in use, without a notice.
    const KEEPS_UNSET_MODEL: bool = false;
    /// In front of the text a dropped connection ends the session with.
    const ERROR_PREFIX: &'static str = "";

    /// Rewrite each message the agent sends before the client reads it: an agent's own fields that ACP's
    /// types would drop can move into `_meta` there. Only called when `REWRITES_INCOMING`.
    const REWRITES_INCOMING: bool = false;
    /// `session/set_config_option` for the model and effort waits for the next prompt (what is picked
    /// during a turn applies to the next one, as a harness that starts a process per turn does).
    const CONFIG_AT_NEXT_PROMPT: bool = false;
    /// The agent goes on after its prompt answers: a command it backgrounded holds the turn open until
    /// the agent's reply to it closes, and a reply it starts with no prompt open is a turn of its own
    /// (`ResponseStarted`), ended the same way. Every reply of such an agent ends with `usage_update`.
    const BACKGROUND_REPLIES: bool = false;
    /// Fail a prompt whose agent says nothing, runs no tool and asks nothing for this long.
    const INACTIVITY_LIMIT: Option<Duration> = None;

    /// The agent's process: binary, arguments for the permission mode, environment. The core adds the
    /// working folder, pipes, `kill_on_drop` and the process group.
    fn command(&self, bin: &Path, config: &SessionConfig) -> Command;
    /// `spawn`'s error for a start that failed at `step`; `detail` is the technical text, `stderr` what the agent printed.
    fn startup_error(&self, step: Startup, detail: &str, stderr: &str) -> DriverError;
    /// `spawn`'s error when the agent quit before the session was bound; its stderr tail says why.
    fn exited_during_startup(&self, stderr: &std::sync::Mutex<String>) -> DriverError;

    /// `initialize`'s `_meta`.
    fn initialize_meta(&self) -> Option<Meta> {
        None
    }
    /// `initialize`'s client name and version.
    fn client_info(&self) -> Implementation {
        Implementation::new("kybern", env!("CARGO_PKG_VERSION"))
    }
    /// See `REWRITES_INCOMING`.
    fn rewrite_incoming(&self, _message: &mut Value) {}
    /// Kybern's MCP servers for `session/new` and `session/load`.
    fn mcp_servers(&self, bridge: Option<&NativeToolBridge>) -> Result<Vec<McpServer>> {
        mcp_servers(Self::NAME, bridge)
    }
    /// `_meta` that puts Kybern's guide in the agent's system prompt, when this agent takes one. The guide
    /// then never rides on a prompt.
    fn system_prompt_meta(&self, _init: &InitializeResponse, _guide: &str) -> Option<Meta> {
        None
    }
    /// [`AcpFlavor::session_mode`], knowing the modes the session advertised.
    fn session_mode_in(&self, mode: PermissionMode, _modes: Option<&SessionModeState>) -> Option<&'static str> {
        self.session_mode(mode)
    }
    /// The config writes for a model and effort, from the session's options; `None` sets option
    /// `model` and `EFFORT_OPTION` as given.
    fn config_selection(&self, _model: Option<&str>, _effort: Option<&str>, _options: &[SessionConfigOption]) -> Option<ConfigSelection> {
        None
    }
    /// A tool that goes on after its prompt answers (see `BACKGROUND_REPLIES`).
    fn tool_outlives_prompt(&self, _call: &AcpToolCall) -> bool {
        false
    }
    /// The turn's end for a prompt whose agent went silent (see `INACTIVITY_LIMIT`).
    fn silent_failure() -> DriverEvent {
        DriverEvent::turn_failed(Self::KIND, format!("{} stopped responding. Send your message again.", Self::NAME))
    }
    /// Where the agent's own record of the session stands before a prompt, for [`AcpFlavor::prompt_outcome`].
    fn prompt_mark(&self, _session_id: &str) -> Option<i64> {
        None
    }
    /// The turn's end, given what the agent recorded for this prompt since `mark` (an agent that reports
    /// a failure as text and `end_turn` records it there).
    fn prompt_outcome(&self, _session_id: &str, _mark: Option<i64>, event: DriverEvent) -> DriverEvent {
        event
    }
    /// A permission request that is really the agent's question to the user.
    fn permission_question(&self, _request: &RequestPermissionRequest) -> Option<Box<dyn ExtensionAsk>> {
        None
    }
    /// The auth method to `authenticate` with after `initialize`, when the agent offers it (its answer is not checked).
    fn auth_method(&self) -> Option<&str> {
        None
    }
    /// `session/new` and `session/load`'s `_meta` (an appended system prompt, say).
    fn session_meta(&self, _init: &InitializeResponse, _config: &SessionConfig) -> Option<Meta> {
        None
    }
    /// The ACP session mode a permission mode starts in (and switches to), if the agent takes one.
    fn session_mode(&self, _mode: PermissionMode) -> Option<&'static str> {
        None
    }
    /// Whether this agent carries a running turn on when it gets the next prompt (else steering falls back).
    fn steers_with_prompt(&self, _init: &InitializeResponse) -> bool {
        false
    }

    /// A user message as the blocks the agent receives.
    fn blocks(&self, message: &UserMessage) -> Vec<ContentBlock> {
        prompt_blocks(message)
    }
    /// `session/prompt`'s `_meta` for a prompt Kybern calls `prompt_id`.
    fn prompt_meta(&self, _prompt_id: &str) -> Option<Meta> {
        None
    }
    /// The agent's completion notice in an extension notification, if it is one.
    fn completion(&self, _method: &str, _params: &Value) -> Option<Self::Completion> {
        None
    }
    /// A turn's tokens and cost from the prompt answer's `_meta`.
    fn turn_usage(&self, _meta: Option<&Meta>) -> (Usage, Option<f64>) {
        (Usage::default(), None)
    }
    /// The turn's end for a failed `session/prompt`.
    fn prompt_failure(&self, error: &agent_client_protocol::Error) -> DriverEvent {
        DriverEvent::turn_failed(Self::KIND, error.to_string())
    }

    /// What a tool call is, from its kind, title, `_meta` and input.
    fn tool_identity(&self, kind: &ToolKind, title: &str, _meta: Option<&Meta>, _raw_input: Option<&Value>) -> ToolIdentity {
        ToolIdentity { name: tool_name(kind, title), mcp_arguments: None }
    }
    /// A started tool call's name and input.
    fn tool_call(&self, call: &AcpToolCall) -> (String, Value) {
        let identity = self.tool_identity(&call.kind, &call.title, call.meta.as_ref(), call.raw_input.as_ref());
        match identity.mcp_arguments {
            Some(arguments) => (identity.name, arguments),
            None => (identity.name, json!({ "title": call.title, "raw": call.raw_input })),
        }
    }
    /// A finished tool call's output and whether it failed. `status` is `completed` or `failed`.
    fn tool_output(&self, status: Option<&str>, fields: ToolCallUpdateFields) -> (Value, bool) {
        let content = serde_json::to_value(&fields.content).unwrap_or(Value::Null);
        (json!({ "status": status, "raw": fields.raw_output, "content": content, "title": fields.title }), status == Some("failed"))
    }
    /// A session update the core doesn't map (a plan, say).
    fn other_update(&self, _update: SessionUpdate) -> Option<DriverEvent> {
        None
    }

    /// The answer Kybern sends without a card, if any.
    fn auto_permission(&self, mode: PermissionMode, request: &RequestPermissionRequest, cwd: &Path) -> Option<RequestPermissionResponse> {
        auto_response(mode, &request.tool_call.fields, cwd, &request.options, None)
    }
    /// The card for a permission request.
    fn permission_card(&self, request: &RequestPermissionRequest) -> PermissionCard {
        let fields = &request.tool_call.fields;
        let title = fields.title.clone().unwrap_or_default();
        let identity =
            self.tool_identity(&fields.kind.unwrap_or(ToolKind::Other), &title, request.tool_call.meta.as_ref(), fields.raw_input.as_ref());
        let raw = identity.mcp_arguments.or_else(|| fields.raw_input.clone());
        let input = json!({ "title": title, "raw": raw, "locations": fields.locations, "options": option_list(&request.options) });
        PermissionCard { tool_name: identity.name, input, summary: title }
    }
    /// The response to the user's decision on a card (`None`: unanswered), and a notice to show with it.
    fn permission_answer(
        &self,
        options: &[PermissionOption],
        decision: Option<&ApprovalDecision>,
    ) -> (RequestPermissionResponse, Option<String>) {
        permission_response(Self::NAME, None, options, decision)
    }
    /// An extension request this flavor handles.
    fn extension_request(&self, _method: &str, _params: &Value) -> Option<Extension> {
        None
    }
}

/// Start a session of `flavor`.
pub(crate) async fn spawn<F: AcpFlavor>(flavor: F, config: SessionConfig) -> Result<SpawnedSession> {
    let bin = resolve(F::KIND, config.binary.as_ref())?;
    // Checked before the agent starts, so a refused bridge costs no process.
    let mcp_servers = flavor.mcp_servers(config.native_tool_bridge.as_ref())?;
    let (events_tx, events_rx) = mpsc::channel(1024);
    let (cmd_tx, cmd_rx) = mpsc::channel::<SessionCommand>(64);
    let (bound_tx, bound_rx) = oneshot::channel::<Result<Bound>>();

    // A new conversation carries Kybern's guide (and a Coordinator's lead instructions) on its first
    // ordinary prompt. A resumed one that already holds it gets nothing; one that never received it gets it once.
    let guide = match (&config.resume_session_id, config.resume_lacks_instructions) {
        _ if !F::CARRIES_GUIDE => None,
        (None, _) | (Some(_), true) => config.native_tool_bridge.as_ref().and_then(|bridge| bridge.provider_instructions()),
        (Some(_), false) => None,
    };

    let flavor = Arc::new(flavor);
    let stderr_tail = Arc::new(std::sync::Mutex::new(String::new()));
    let (stderr_closed_tx, mut stderr_closed) = tokio::sync::watch::channel(false);
    let shared = Arc::new(Shared::new(events_tx.clone(), config.permission_mode, config.cwd.clone()));
    *shared.lock_config() = Config { model: config.model.clone(), effort: config.effort.clone(), ..Config::default() };
    let (finished, closed) = tokio::sync::watch::channel(());
    let connection = Connection {
        flavor: flavor.clone(),
        bin,
        config,
        guide: guide.clone(),
        mcp_servers,
        shared: shared.clone(),
        stderr_tail: stderr_tail.clone(),
        stderr_closed: stderr_closed_tx,
    };
    let worker = crate::process_tree::SessionTask(tokio::spawn(async move {
        let _finished = finished;
        let outcome = connection.run(cmd_rx, bound_tx).await;
        let error = outcome.err().map(|e| e.to_string());
        let _ = events_tx.send(DriverEvent::Exited { code: None, error }).await;
    }));

    let bound = match bound_rx.await {
        Ok(Ok(bound)) => bound,
        Ok(Err(e)) => return Err(e),
        Err(_) => {
            startup::stderr_settled(&mut stderr_closed).await;
            return Err(flavor.exited_during_startup(&stderr_tail));
        }
    };
    // A guide the agent's system prompt carries never rides on a prompt.
    let guide = if bound.guide_in_system_prompt { None } else { guide };
    let handle = Handle { flavor, commands: cmd_tx, guide: Mutex::new(guide), shared, steers: bound.steers, closed, worker };
    Ok(SpawnedSession { session: Box::new(handle), events: events_rx })
}

/// A bound session, as the worker reports it to `spawn`.
struct Bound {
    /// The agent carries a running turn on with the next prompt.
    steers: bool,
    /// Kybern's guide went into the agent's system prompt.
    guide_in_system_prompt: bool,
}

/// The session's config: what the agent offers, and the model and effort Kybern wants.
#[derive(Debug, Default)]
struct Config {
    /// The modes `session/new` (or `session/load`) advertised.
    modes: Option<SessionModeState>,
    /// The agent's config options, as it last reported them.
    options: Vec<SessionConfigOption>,
    model: Option<String>,
    effort: Option<String>,
    /// The model and effort still to be applied before the next prompt (`CONFIG_AT_NEXT_PROMPT`).
    stale: bool,
}

struct Shared {
    events: mpsc::Sender<DriverEvent>,
    /// Open cards: Kybern's request id -> what it asks and where the answer goes.
    pending: Mutex<HashMap<String, (Ask, oneshot::Sender<ApprovalDecision>)>>,
    /// The mode Kybern's own permission answers follow.
    mode: std::sync::Mutex<PermissionMode>,
    cwd: PathBuf,
    config: std::sync::Mutex<Config>,
    activity: std::sync::Mutex<turn::Activity>,
    /// Rings when the agent starts a reply by itself.
    woke: tokio::sync::Notify,
}

impl Shared {
    fn new(events: mpsc::Sender<DriverEvent>, mode: PermissionMode, cwd: PathBuf) -> Self {
        Self {
            events,
            pending: Mutex::new(HashMap::new()),
            mode: std::sync::Mutex::new(mode),
            cwd,
            config: std::sync::Mutex::new(Config::default()),
            activity: std::sync::Mutex::new(turn::Activity::new()),
            woke: tokio::sync::Notify::new(),
        }
    }

    fn mode(&self) -> PermissionMode {
        *self.mode.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn lock_config(&self) -> std::sync::MutexGuard<'_, Config> {
        self.config.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn lock_activity(&self) -> std::sync::MutexGuard<'_, turn::Activity> {
        self.activity.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Raise a card and return where its answer arrives. A dropped sender (the turn ended) reads as no answer.
    async fn ask(&self, kind: Ask, event: impl FnOnce(String) -> DriverEvent) -> oneshot::Receiver<ApprovalDecision> {
        let request_id = uuid::Uuid::new_v4().simple().to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(request_id.clone(), (kind, tx));
        self.lock_activity().cards += 1;
        let _ = self.events.send(event(request_id)).await;
        rx
    }

    /// A card was answered (or its turn ended).
    fn card_closed(&self) {
        let mut activity = self.lock_activity();
        activity.cards = activity.cards.saturating_sub(1);
        activity.last_progress = tokio::time::Instant::now();
    }

    /// The turn ended: the agent no longer waits for any open card.
    async fn withdraw_all(&self) {
        let open: Vec<String> = self.pending.lock().await.drain().map(|(id, _)| id).collect();
        for request_id in open {
            let _ = self.events.send(DriverEvent::PermissionWithdrawn { request_id }).await;
        }
    }

    /// The agent sent output with no turn open: it started a reply by itself, which opens one
    /// (`BACKGROUND_REPLIES`). Returns whether it did.
    fn open_background_turn(&self) -> bool {
        let mut activity = self.lock_activity();
        if activity.turn_open {
            return false;
        }
        activity.turn_open = true;
        activity.background = true;
        activity.reply_open = true;
        activity.last_progress = tokio::time::Instant::now();
        drop(activity);
        self.woke.notify_one();
        true
    }
}

/// Everything the worker needs to run the connection.
struct Connection<F> {
    flavor: Arc<F>,
    bin: PathBuf,
    config: SessionConfig,
    /// Kybern's guide, which the flavor may put in the system prompt.
    guide: Option<String>,
    mcp_servers: Vec<McpServer>,
    shared: Arc<Shared>,
    stderr_tail: Arc<std::sync::Mutex<String>>,
    stderr_closed: tokio::sync::watch::Sender<bool>,
}

/// Synthetic message ids: one per contiguous run of agent chunks.
#[derive(Default)]
struct MessageIds {
    count: u64,
    open: bool,
}

impl MessageIds {
    fn current(&mut self) -> String {
        if !self.open {
            self.count += 1;
            self.open = true;
        }
        format!("m{}", self.count)
    }
}

/// What `session/prompt`'s wait can do to the agent: cancel, and steer by sending the next prompt.
struct Control<'a, F> {
    cx: &'a ConnectionTo<Agent>,
    session_id: &'a SessionId,
    flavor: &'a F,
    started: std::time::Instant,
}

impl<'a, F: AcpFlavor> turn::PromptControl<'a> for Control<'a, F> {
    fn cancel(&mut self) {
        let _ = self.cx.send_notification(CancelNotification::new(self.session_id.clone()));
    }

    fn steer(&mut self, blocks: Vec<ContentBlock>) -> Option<(String, turn::PromptAnswer<'a>)> {
        Some(send_prompt(self.cx, self.session_id, self.flavor, blocks, self.started))
    }
}

/// Send `session/prompt` with Kybern's own prompt id: the id, and its answer as the turn's end.
fn send_prompt<'a, F: AcpFlavor>(
    cx: &'a ConnectionTo<Agent>,
    session_id: &SessionId,
    flavor: &'a F,
    blocks: Vec<ContentBlock>,
    started: std::time::Instant,
) -> (String, turn::PromptAnswer<'a>) {
    let prompt_id = format!("kybern-{}", uuid::Uuid::new_v4().simple());
    let prompt = cx.send_request(PromptRequest::new(session_id.clone(), blocks).meta(flavor.prompt_meta(&prompt_id)));
    let answer = async move {
        match prompt.block_task().await {
            Ok(r) => {
                let (usage, cost_usd) = flavor.turn_usage(r.meta.as_ref());
                let duration_ms = started.elapsed().as_millis() as u64;
                DriverEvent::TurnCompleted {
                    stop_reason: turn::stop_reason(r.stop_reason),
                    usage,
                    cost_usd,
                    duration_ms,
                    anchors: Default::default(),
                }
            }
            Err(e) => flavor.prompt_failure(&e),
        }
    };
    (prompt_id, Box::pin(answer))
}

/// The agent's stdout with each message rewritten by the flavor (`REWRITES_INCOMING`). A line that is
/// not JSON passes as it is.
fn rewritten<F: AcpFlavor>(flavor: Arc<F>, stdout: tokio::process::ChildStdout) -> tokio::io::DuplexStream {
    let (mut writer, reader) = tokio::io::duplex(64 * 1024);
    tokio::spawn(async move {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
        let mut stdout = tokio::io::BufReader::new(stdout);
        let mut line = Vec::new();
        loop {
            line.clear();
            match stdout.read_until(b'\n', &mut line).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let text = String::from_utf8_lossy(&line);
            let out = match serde_json::from_str::<Value>(text.trim_end()) {
                Ok(mut message) => {
                    flavor.rewrite_incoming(&mut message);
                    message.to_string()
                }
                Err(_) => text.trim_end_matches(['\n', '\r']).to_string(),
            };
            if writer.write_all(out.as_bytes()).await.is_err() || writer.write_all(b"\n").await.is_err() {
                break;
            }
        }
    });
    reader
}

/// Set the model and effort through the session's config options: the model now in use, or (when it
/// couldn't be set) the model to report and a notice. `starting` words the notice for a new session.
async fn apply_config<F: AcpFlavor>(
    cx: &ConnectionTo<Agent>,
    session_id: &SessionId,
    flavor: &F,
    shared: &Shared,
    model: Option<String>,
    effort: Option<&str>,
) -> std::result::Result<Option<String>, (Option<String>, String)> {
    let set = async |id: &str, value: &str| {
        let set = cx
            .send_request(SetSessionConfigOptionRequest::new(
                session_id.clone(),
                id.to_owned(),
                SessionConfigValueId::new(value.to_owned()),
            ))
            .block_task()
            .await;
        if let Ok(set) = &set {
            shared.lock_config().options = set.config_options.clone();
        }
        set
    };
    let options = shared.lock_config().options.clone();
    if let Some(selection) = flavor.config_selection(model.as_deref(), effort, &options) {
        for (id, value) in &selection.writes {
            if let Err(e) = set(id, value).await
                && !F::KEEPS_UNSET_MODEL
            {
                let wanted = model.as_deref().unwrap_or(value);
                return Err((None, format!("{} could not switch to {wanted}: {e}. It is using its default model.", F::NAME)));
            }
        }
        return Ok(selection.model);
    }
    let mut model = model;
    let mut notice = None;
    if let Some(wanted) = model.clone()
        && let Err(e) = set("model", &wanted).await
        && !F::KEEPS_UNSET_MODEL
    {
        notice = Some(format!("{} could not switch to {wanted}: {e}. It is using its default model.", F::NAME));
        model = None;
    }
    if let (Some(effort), Some(option)) = (effort, F::EFFORT_OPTION) {
        let _ = set(option, effort).await;
    }
    match notice {
        Some(notice) => Err((model, notice)),
        None => Ok(model),
    }
}

impl<F: AcpFlavor> Connection<F> {
    async fn run(self, mut commands: mpsc::Receiver<SessionCommand>, bound: oneshot::Sender<Result<Bound>>) -> Result<()> {
        let Connection { flavor, bin, config, guide, mcp_servers, shared, stderr_tail, stderr_closed: stderr_closed_tx } = self;
        let mut bound = Some(bound);
        let timings = turn::Timings::for_session::<F>(&config);

        let mut cmd = flavor.command(&bin, &config);
        cmd.current_dir(&config.cwd)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
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
        let _tree = crate::process_tree::ProcessTree::new(child.id().expect("spawned ACP agent"));
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
        let incoming: std::pin::Pin<Box<dyn tokio::io::AsyncRead + Send>> =
            if F::REWRITES_INCOMING { Box::pin(rewritten(flavor.clone(), stdout)) } else { Box::pin(stdout) };
        let agent = ByteStreams::new(stdin.compat_write(), incoming.compat());
        let _child_guard = child; // killed on drop when the connection ends

        let cwd = config.cwd.clone();
        let messages = Arc::new(Mutex::new(MessageIds::default()));
        // `session/load` replays the whole conversation as updates; those are history, not new output.
        // Their arrival times tell when the replay has gone quiet.
        let loading = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let last_replay: Arc<std::sync::Mutex<Option<tokio::time::Instant>>> = Arc::new(std::sync::Mutex::new(None));
        // The agent's own "this prompt is done" notices, for a prompt whose RPC never answers.
        let (completions_tx, mut completions) = mpsc::unbounded_channel::<F::Completion>();

        let on_update = {
            let (flavor, shared, events, messages, loading, last_replay) =
                (flavor.clone(), shared.clone(), shared.events.clone(), messages.clone(), loading.clone(), last_replay.clone());
            async move |n: SessionNotification, _cx| {
                // The agent's config options are its state, whenever they change.
                if let SessionUpdate::ConfigOptionUpdate(update) = &n.update {
                    shared.lock_config().options = update.config_options.clone();
                }
                if loading.load(std::sync::atomic::Ordering::Relaxed) {
                    if let Ok(mut last) = last_replay.lock() {
                        *last = Some(tokio::time::Instant::now());
                    }
                    // Commands and context usage are the session's state, not its history.
                    if !matches!(n.update, SessionUpdate::AvailableCommandsUpdate(_) | SessionUpdate::UsageUpdate(_)) {
                        return Ok(());
                    }
                }
                let output = matches!(
                    n.update,
                    SessionUpdate::AgentMessageChunk(_)
                        | SessionUpdate::AgentThoughtChunk(_)
                        | SessionUpdate::ToolCall(_)
                        | SessionUpdate::ToolCallUpdate(_)
                );
                {
                    let mut activity = shared.lock_activity();
                    activity.last_progress = tokio::time::Instant::now();
                    match &n.update {
                        SessionUpdate::ToolCall(call) if !matches!(call.status, ToolCallStatus::Completed | ToolCallStatus::Failed) => {
                            activity.tools.insert(call.tool_call_id.to_string(), flavor.tool_outlives_prompt(call));
                        }
                        SessionUpdate::ToolCallUpdate(update)
                            if matches!(update.fields.status, Some(ToolCallStatus::Completed | ToolCallStatus::Failed)) =>
                        {
                            activity.tools.remove(&update.tool_call_id.to_string());
                        }
                        SessionUpdate::UsageUpdate(_) => activity.reply_open = false,
                        _ => {}
                    }
                    if output {
                        activity.reply_open = true;
                    }
                }
                // A reply the agent starts by itself, with no prompt open, is a turn of its own.
                if F::BACKGROUND_REPLIES && output && shared.open_background_turn() {
                    let _ = events.send(DriverEvent::ResponseStarted).await;
                }
                let event = match n.update {
                    SessionUpdate::AgentMessageChunk(c) => {
                        if F::AGENT_IMAGES
                            && let ContentBlock::Image(image) = &c.content
                        {
                            let source = format!("data:{};base64,{}", image.mime_type, image.data);
                            let image =
                                DriverEvent::ImageReceived { id: uuid::Uuid::new_v4().to_string(), origin: EventOrigin::Root, source };
                            let _ = events.send(image).await;
                        }
                        match c.content {
                            ContentBlock::Text(t) => {
                                let message_id = messages.lock().await.current();
                                Some(DriverEvent::TextDelta { message_id, origin: EventOrigin::Root, delta: t.text })
                            }
                            _ => None,
                        }
                    }
                    SessionUpdate::AgentThoughtChunk(c) => match c.content {
                        ContentBlock::Text(t) => {
                            let message_id = messages.lock().await.current();
                            Some(DriverEvent::ThinkingDelta { message_id, origin: EventOrigin::Root, delta: t.text })
                        }
                        _ => None,
                    },
                    SessionUpdate::ToolCall(tc) => {
                        // A tool call ends the current assistant message run.
                        messages.lock().await.open = false;
                        let (name, input) = flavor.tool_call(&tc);
                        Some(DriverEvent::ToolStarted(ToolCall { id: tc.tool_call_id.to_string(), name, input, parent_id: None }))
                    }
                    SessionUpdate::ToolCallUpdate(u) => {
                        let status = u.fields.status.map(|s| format!("{s:?}").to_lowercase());
                        if matches!(status.as_deref(), Some("completed") | Some("failed")) {
                            let (output, is_error) = flavor.tool_output(status.as_deref(), u.fields);
                            Some(DriverEvent::ToolCompleted { tool_call_id: u.tool_call_id.to_string(), output, is_error })
                        } else {
                            None
                        }
                    }
                    SessionUpdate::AvailableCommandsUpdate(update) => Some(command_update(update)),
                    SessionUpdate::UsageUpdate(u) => {
                        let context = Some(ContextUsage { used_tokens: u.used, window_tokens: u.size });
                        Some(DriverEvent::UsageUpdated(ProviderUsage { context, limits: None, prompt_cache: None }))
                    }
                    other => flavor.other_update(other),
                };
                if let Some(event) = event {
                    let _ = events.send(event).await;
                }
                Ok(())
            }
        };

        let on_notice = {
            let flavor = flavor.clone();
            async move |n: UntypedMessage, _cx| {
                if let Some(complete) = flavor.completion(&n.method, &n.params) {
                    let _ = completions_tx.send(complete);
                }
                // Other extension notices (setup phases, MCP status, background tasks) are not used yet.
                Ok(())
            }
        };

        let on_permission = {
            let (flavor, shared) = (flavor.clone(), shared.clone());
            async move |req: RequestPermissionRequest, responder: Responder<RequestPermissionResponse>, cx: ConnectionTo<Agent>| {
                if F::BACKGROUND_REPLIES && shared.open_background_turn() {
                    let _ = shared.events.send(DriverEvent::ResponseStarted).await;
                }
                if let Some(ask) = flavor.permission_question(&req) {
                    let rx = shared.ask(ask.kind(), |request_id| ask.card(request_id)).await;
                    let shared = shared.clone();
                    return cx.spawn(async move {
                        let decision = rx.await.ok();
                        shared.card_closed();
                        let response = serde_json::from_value(ask.response(decision)).unwrap_or_else(|_| cancelled());
                        let _ = responder.respond(response);
                        Ok(())
                    });
                }
                if let Some(response) = flavor.auto_permission(shared.mode(), &req, &shared.cwd) {
                    return responder.respond(response);
                }
                let card = flavor.permission_card(&req);
                let rx = shared
                    .ask(Ask::Permission, |request_id| DriverEvent::PermissionRequest {
                        request_id,
                        tool_call_id: Some(req.tool_call.tool_call_id.to_string()),
                        tool_name: card.tool_name,
                        input: card.input,
                        summary: card.summary,
                        suggestions: vec![],
                    })
                    .await;
                // Wait off the dispatch loop: the agent's updates and the prompt's answer keep flowing meanwhile.
                let options = req.options;
                let (flavor, events, shared) = (flavor.clone(), shared.events.clone(), shared.clone());
                cx.spawn(async move {
                    let decision = rx.await.ok();
                    shared.card_closed();
                    let (response, notice) = flavor.permission_answer(&options, decision.as_ref());
                    if let Some(text) = notice {
                        let _ = events.send(DriverEvent::Notice { level: NoticeLevel::Warning, text, data: None }).await;
                    }
                    let _ = responder.respond(response);
                    Ok(())
                })
            }
        };

        let on_extension = {
            let (flavor, shared) = (flavor.clone(), shared.clone());
            async move |req: UntypedMessage, responder: Responder<Value>, cx: ConnectionTo<Agent>| {
                let Some(extension) = flavor.extension_request(&req.method, &req.params) else {
                    return Ok(Handled::No { message: (req, responder), retry: false });
                };
                match extension {
                    Extension::Answer(answer) => responder.respond(answer)?,
                    Extension::Ask(ask) => {
                        let rx = shared.ask(ask.kind(), |request_id| ask.card(request_id)).await;
                        let shared = shared.clone();
                        cx.spawn(async move {
                            let decision = rx.await.ok();
                            shared.card_closed();
                            let _ = responder.respond(ask.response(decision));
                            Ok(())
                        })?;
                    }
                }
                Ok(Handled::Yes)
            }
        };

        let result = Client
            .builder()
            .name("kybern")
            .on_receive_notification(on_update, on_receive_notification!())
            .on_receive_notification(on_notice, on_receive_notification!())
            .on_receive_request(on_permission, on_receive_request!())
            .on_receive_request(on_extension, on_receive_request!())
            .connect_with(agent, async |cx: ConnectionTo<Agent>| {
                let init = cx
                    .send_request(
                        InitializeRequest::new(ProtocolVersion::V1)
                            .client_capabilities(ClientCapabilities::new())
                            .client_info(flavor.client_info())
                            .meta(flavor.initialize_meta()),
                    )
                    .block_task()
                    .await;
                let init = match init {
                    Ok(init) => init,
                    Err(e) => {
                        // An agent that quit (an option it doesn't know, a crash) has said why on stderr.
                        startup::stderr_settled(&mut stderr_closed).await;
                        let stderr = stderr_text(&stderr_tail);
                        let detail = if stderr.is_empty() { format!("initialize: {e}") } else { format!("initialize: {e}\n{stderr}") };
                        return Err(fail_startup(&mut bound, flavor.startup_error(Startup::Initialize, &detail, &stderr)));
                    }
                };
                let method = flavor.auth_method().filter(|method| init.auth_methods.iter().any(|m| m.id().to_string() == *method));
                if let Some(method) = method.map(str::to_owned) {
                    let _ = cx.send_request(AuthenticateRequest::new(method)).block_task().await;
                }

                let mut session_meta = flavor.session_meta(&init, &config);
                // The guide goes in the system prompt when this agent takes one there.
                let guide_meta = guide.as_deref().and_then(|guide| flavor.system_prompt_meta(&init, guide));
                let guide_in_system_prompt = guide_meta.is_some();
                if let Some(extra) = guide_meta {
                    session_meta.get_or_insert_with(Meta::new).extend(extra);
                }
                let session_id = match &config.resume_session_id {
                    Some(id) => {
                        loading.store(true, std::sync::atomic::Ordering::Relaxed);
                        let request = LoadSessionRequest::new(id.clone(), cwd.clone()).mcp_servers(mcp_servers.clone()).meta(session_meta);
                        let load = cx.send_request(request).block_task();
                        match turn::await_session_load(load, &last_replay, timings.replay_idle, timings.load_timeout).await {
                            turn::LoadOutcome::Answered(Ok(loaded)) => {
                                loading.store(false, std::sync::atomic::Ordering::Relaxed);
                                let mut state = shared.lock_config();
                                state.modes = loaded.modes;
                                if let Some(options) = loaded.config_options {
                                    state.options = options;
                                }
                                drop(state);
                                SessionId::from(id.clone())
                            }
                            // A quiet replay only ends the wait: the agent may still be replaying, so its updates
                            // stay history until the first prompt is sent.
                            turn::LoadOutcome::ReplayIdle => SessionId::from(id.clone()),
                            // A fresh session here would silently drop the conversation, so the thread is told
                            // it could not be resumed.
                            turn::LoadOutcome::Answered(Err(e)) => {
                                let error = flavor.startup_error(Startup::Resume, &format!("session/load {id}: {e}"), "");
                                return Err(fail_startup(&mut bound, error));
                            }
                            turn::LoadOutcome::TimedOut => {
                                let seconds = timings.load_timeout.map_or(0, |timeout| timeout.as_secs());
                                let detail = format!("session/load {id}: no answer or replay in {seconds} seconds");
                                return Err(fail_startup(&mut bound, flavor.startup_error(Startup::ResumeTimedOut, &detail, "")));
                            }
                        }
                    }
                    None => {
                        let request = NewSessionRequest::new(cwd.clone()).mcp_servers(mcp_servers).meta(session_meta);
                        match cx.send_request(request).block_task().await {
                            Ok(created) => {
                                let mut state = shared.lock_config();
                                state.modes = created.modes;
                                if let Some(options) = created.config_options {
                                    state.options = options;
                                }
                                drop(state);
                                created.session_id
                            }
                            Err(e) => {
                                let error = flavor.startup_error(Startup::NewSession, &format!("session/new: {e}"), "");
                                return Err(fail_startup(&mut bound, error));
                            }
                        }
                    }
                };

                let modes = shared.lock_config().modes.clone();
                if let Some(mode) = flavor.session_mode_in(config.permission_mode, modes.as_ref()) {
                    let _ = cx.send_request(SetSessionModeRequest::new(session_id.clone(), mode)).block_task().await;
                }
                // A model that cannot be set must not pass as the one in use, unless the flavor says otherwise.
                let (model, model_notice) =
                    match apply_config::<F>(&cx, &session_id, &*flavor, &shared, config.model.clone(), config.effort.as_deref()).await {
                        Ok(model) => (model, None),
                        Err((model, notice)) => (model, Some(notice)),
                    };

                if let Some(b) = bound.take() {
                    let _ = b.send(Ok(Bound { steers: flavor.steers_with_prompt(&init), guide_in_system_prompt }));
                }
                let _ = shared.events.send(DriverEvent::SessionBound { session_id: session_id.to_string(), model }).await;
                if let Some(text) = model_notice {
                    let _ = shared.events.send(DriverEvent::Notice { level: NoticeLevel::Warning, text, data: None }).await;
                }

                let watch = |held: Option<DriverEvent>| {
                    (F::BACKGROUND_REPLIES || F::INACTIVITY_LIMIT.is_some()).then(|| turn::Watch {
                        activity: &shared.activity,
                        holds: F::BACKGROUND_REPLIES,
                        inactivity: F::INACTIVITY_LIMIT,
                        silent: F::silent_failure,
                        held,
                    })
                };
                // A turn ended: the next output opens a new message, and a new turn if no prompt is open.
                let turn_ended = async |event: DriverEvent| {
                    {
                        let mut activity = shared.lock_activity();
                        activity.turn_open = false;
                        activity.background = false;
                    }
                    shared.withdraw_all().await;
                    let _ = shared.events.send(event).await;
                    messages.lock().await.open = false;
                };
                let mut next_command: Option<SessionCommand> = None;
                loop {
                    let cmd = match next_command.take() {
                        Some(cmd) => cmd,
                        None => tokio::select! {
                            cmd = commands.recv() => match cmd {
                                Some(cmd) => cmd,
                                None => break,
                            },
                            // The agent started a reply by itself: settle it as a turn of its own.
                            () = shared.woke.notified(), if F::BACKGROUND_REPLIES => {
                                if !shared.lock_activity().background {
                                    continue;
                                }
                                let started = std::time::Instant::now();
                                let held = DriverEvent::TurnCompleted {
                                    stop_reason: StopReason::Completed,
                                    usage: Usage::default(),
                                    cost_usd: None,
                                    duration_ms: 0,
                                    anchors: Default::default(),
                                };
                                let control = Control { cx: &cx, session_id: &session_id, flavor: &*flavor, started };
                                let settled = turn::settle_watched(
                                    std::future::pending(),
                                    "",
                                    started,
                                    &mut completions,
                                    &mut commands,
                                    timings.cancel_grace,
                                    control,
                                    watch(Some(held)),
                                )
                                .await;
                                turn_ended(settled.event).await;
                                if settled.close {
                                    break;
                                }
                                next_command = settled.next.map(|blocks| SessionCommand::Prompt { blocks });
                                continue;
                            }
                        },
                    };
                    match cmd {
                        SessionCommand::Prompt { blocks } => {
                            // Whatever a resume still replays after this is this prompt's output.
                            loading.store(false, std::sync::atomic::Ordering::Relaxed);
                            // A model or effort picked since the last prompt applies to this one.
                            if F::CONFIG_AT_NEXT_PROMPT && std::mem::take(&mut shared.lock_config().stale) {
                                let (model, effort) = {
                                    let state = shared.lock_config();
                                    (state.model.clone(), state.effort.clone())
                                };
                                let (model, notice) =
                                    match apply_config::<F>(&cx, &session_id, &*flavor, &shared, model, effort.as_deref()).await {
                                        Ok(model) => (model, None),
                                        Err((model, notice)) => (model, Some(notice)),
                                    };
                                let _ = shared.events.send(DriverEvent::SessionBound { session_id: session_id.to_string(), model }).await;
                                if let Some(text) = notice {
                                    let _ = shared.events.send(DriverEvent::Notice { level: NoticeLevel::Warning, text, data: None }).await;
                                }
                            }
                            let mark = flavor.prompt_mark(&session_id.0);
                            let started = std::time::Instant::now();
                            messages.lock().await.open = false;
                            {
                                let mut activity = shared.lock_activity();
                                activity.turn_open = true;
                                activity.background = false;
                                activity.reply_open = false;
                                activity.last_progress = tokio::time::Instant::now();
                            }
                            let (prompt_id, answer) = send_prompt(&cx, &session_id, &*flavor, blocks, started);
                            let control = Control { cx: &cx, session_id: &session_id, flavor: &*flavor, started };
                            let settled = turn::settle_watched(
                                answer,
                                &prompt_id,
                                started,
                                &mut completions,
                                &mut commands,
                                timings.cancel_grace,
                                control,
                                watch(None),
                            )
                            .await;
                            let event = flavor.prompt_outcome(&session_id.0, mark, settled.event);
                            turn_ended(event).await;
                            if settled.close {
                                break;
                            }
                        }
                        // The turn it was meant for has ended: the daemon sends it as a follow-up.
                        SessionCommand::Steer { reply, .. } => {
                            let _ = reply.send(Err(DriverError::SteerFallback));
                        }
                        SessionCommand::Cancel => {
                            let _ = cx.send_notification(CancelNotification::new(session_id.clone()));
                        }
                        SessionCommand::SetMode { mode, id, reply } => {
                            let set = cx.send_request(SetSessionModeRequest::new(session_id.clone(), id)).block_task().await;
                            if set.is_ok() && F::POLICY_FOLLOWS_MODE {
                                *shared.mode.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = mode;
                            }
                            let _ = reply.send(set.map(|_| ()).map_err(|e| DriverError::Protocol(e.to_string())));
                        }
                        SessionCommand::SetConfig { id, value, reply } => {
                            let set = cx
                                .send_request(SetSessionConfigOptionRequest::new(session_id.clone(), id, value.as_str()))
                                .block_task()
                                .await;
                            if let Ok(set) = &set {
                                shared.lock_config().options = set.config_options.clone();
                            }
                            let _ = reply.send(set.map(|_| ()).map_err(|e| DriverError::Protocol(e.to_string())));
                        }
                        SessionCommand::Close => break,
                    }
                }
                Ok(())
            })
            .await;

        result.map_err(|e| DriverError::Protocol(format!("{}{e}", F::ERROR_PREFIX)))
    }
}

/// A running ACP session.
pub(crate) struct Handle<F> {
    flavor: Arc<F>,
    commands: mpsc::Sender<SessionCommand>,
    /// Kybern's guide, until the first prompt that can carry it is sent.
    guide: Mutex<Option<String>>,
    shared: Arc<Shared>,
    /// The agent carries a running turn on with the next prompt.
    steers: bool,
    /// Changes (closes) when the worker has ended.
    closed: tokio::sync::watch::Receiver<()>,
    worker: crate::process_tree::SessionTask,
}

impl<F: AcpFlavor> Handle<F> {
    fn closed_error() -> DriverError {
        DriverError::ProcessExited(F::CLOSED.into())
    }

    /// The prompt's blocks, the guide in front if it is still to be sent. Returns the guide it carries.
    async fn blocks(&self, message: &UserMessage) -> (Vec<ContentBlock>, Option<String>) {
        blocks_with_guide(&mut *self.guide.lock().await, self.flavor.blocks(message))
    }

    /// The agent never saw the prompt that carried the guide: offer it again with the retry.
    async fn restore_guide(&self, guide: Option<String>) {
        if guide.is_some() {
            *self.guide.lock().await = guide;
        }
    }

    /// Send a command that answers, and wait for its answer.
    async fn request(&self, command: impl FnOnce(oneshot::Sender<Result<()>>) -> SessionCommand) -> Result<()> {
        let (tx, rx) = oneshot::channel();
        self.commands.send(command(tx)).await.map_err(|_| Self::closed_error())?;
        rx.await.map_err(|_| Self::closed_error())?
    }

    /// A handle with no agent behind it, for tests of what a handle answers by itself.
    #[cfg(test)]
    pub(crate) fn detached(flavor: F) -> Self {
        let (commands, _) = mpsc::channel(1);
        let (events, _) = mpsc::channel(1);
        let (_finished, closed) = tokio::sync::watch::channel(());
        let shared = Arc::new(Shared::new(events, PermissionMode::Auto, PathBuf::new()));
        let worker = crate::process_tree::SessionTask(tokio::spawn(async {}));
        Self { flavor: Arc::new(flavor), commands, guide: Mutex::new(None), shared, steers: false, closed, worker }
    }
}

#[async_trait]
impl<F: AcpFlavor> AgentSession for Handle<F> {
    async fn send_message(&self, _message_id: &str, message: &UserMessage) -> Result<()> {
        let (blocks, guide) = self.blocks(message).await;
        if self.commands.send(SessionCommand::Prompt { blocks }).await.is_err() {
            self.restore_guide(guide).await;
            return Err(Self::closed_error());
        }
        Ok(())
    }

    async fn steer(&self, _message_id: &str, message: &UserMessage) -> Result<()> {
        if !self.steers {
            return Err(if F::STEER_FALLBACK { DriverError::SteerFallback } else { DriverError::Unsupported(crate::NO_STEERING.into()) });
        }
        let (blocks, guide) = self.blocks(message).await;
        let sent = self.request(|reply| SessionCommand::Steer { blocks, reply }).await;
        if sent.is_err() {
            self.restore_guide(guide).await;
        }
        sent
    }

    async fn compact(&self) -> Result<()> {
        match F::COMPACT {
            Some(command) => self.send_message(&uuid::Uuid::now_v7().to_string(), &UserMessage::text(command)).await,
            None => Err(DriverError::Unsupported(crate::NO_COMPACTION.into())),
        }
    }

    async fn interrupt(&self) -> Result<()> {
        match self.commands.send(SessionCommand::Cancel).await {
            Err(_) if F::INTERRUPT_REPORTS_CLOSED => Err(Self::closed_error()),
            _ => Ok(()),
        }
    }

    async fn set_permission_mode(&self, mode: PermissionMode) -> Result<()> {
        let modes = self.shared.lock_config().modes.clone();
        let id = self.flavor.session_mode_in(mode, modes.as_ref()).ok_or_else(|| DriverError::Unsupported(F::NO_MODE_SWITCH.into()))?;
        self.request(|reply| SessionCommand::SetMode { mode, id, reply }).await
    }

    async fn set_model(&self, model: &str) -> Result<()> {
        if let Some(why) = F::NO_MODEL_SWITCH {
            return Err(DriverError::Unsupported(why.into()));
        }
        if F::CONFIG_AT_NEXT_PROMPT {
            let mut state = self.shared.lock_config();
            state.model = Some(model.to_owned());
            state.stale = true;
            return Ok(());
        }
        self.request(|reply| SessionCommand::SetConfig { id: "model".into(), value: model.into(), reply }).await
    }

    async fn set_effort(&self, effort: &str) -> Result<()> {
        if F::CONFIG_AT_NEXT_PROMPT {
            let mut state = self.shared.lock_config();
            state.effort = Some(effort.to_owned());
            state.stale = true;
            return Ok(());
        }
        let id = F::EFFORT_OPTION.ok_or_else(|| DriverError::Unsupported(F::NO_EFFORT_SWITCH.into()))?;
        self.request(|reply| SessionCommand::SetConfig { id: id.into(), value: effort.into(), reply }).await
    }

    async fn respond_permission(&self, request_id: &str, decision: &ApprovalDecision) -> Result<()> {
        let mut pending = self.shared.pending.lock().await;
        let Some((kind, _)) = pending.get(request_id) else {
            return Err(DriverError::Protocol(format!("no pending approval {request_id}")));
        };
        if matches!(decision, ApprovalDecision::Submit { .. }) && *kind != Ask::Question {
            return Err(DriverError::Unsupported(format!("{} only takes an answer to its own questions", F::NAME)));
        }
        let (_, tx) = pending.remove(request_id).expect("checked above");
        let _ = tx.send(decision.clone());
        Ok(())
    }

    async fn close(&self) -> Result<()> {
        let Some(wait) = F::CLOSE_WAIT else {
            let _ = self.commands.send(SessionCommand::Close).await;
            return Ok(());
        };
        let mut closed = self.closed.clone();
        let graceful = async {
            let _ = self.commands.send(SessionCommand::Close).await;
            let _ = closed.changed().await;
        };
        if tokio::time::timeout(wait, graceful).await.is_err() {
            self.worker.0.abort();
            let _ = closed.changed().await;
        }
        Ok(())
    }
}
