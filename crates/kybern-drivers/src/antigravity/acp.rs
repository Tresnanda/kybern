//! Antigravity over ACP: one long-lived `agy acp` per session, as a flavor of the shared ACP client
//! (`crate::acp`). The `-p` driver next to it stays as the fallback (`super::Transport`).
//!
//! Seen from a real `agy` 1.5.14 (`agy acp --help`, and `initialize`, `session/new`, prompts, Stop,
//! steering and `session/load` against a scratch home):
//! - `initialize` advertises `loadSession`, images, `sessionCapabilities.resume`, and
//!   `_meta.antigravity.systemPrompt.append: true` (an appended system prompt in `session/new`'s
//!   `_meta.antigravity.systemPrompt.append`, which the conversation keeps).
//! - `session/new` answers `modes` (`default`, `accept-edits`, `auto`, `plan`) and `configOptions`:
//!   `model` (a family, `gemini-3.8-flash`) and `thought_level` (category `thought_level`). The tier
//!   slugs `agy models` lists (`gemini-3.8-flash-high`) are a family plus a thinking level.
//! - In `default` mode agy asks with `session/request_permission` (options `allow`/`allow_once` and
//!   `deny`/`reject_once`) before a command or an edit.
//! - Tool calls carry agy's own tool name in a top-level `name` (and the input again as `args`),
//!   which ACP's types drop: [`AgyAcp::rewrite_incoming`] moves it into `_meta`.
//! - `session/prompt` answers with a per-turn `usage` (`inputTokens` without cache reads,
//!   `outputTokens` already counting `thoughtTokens`, `cachedReadTokens`), which ACP's types drop too.
//! - A prompt sent while one runs carries the turn on (the first answers `end_turn` at once);
//!   `session/cancel` answers the prompt `cancelled` and fails its running command.
//! - Conversations are the same as `-p`'s: `agy acp` resumes a `-p` conversation and the other way round.
//!
//! What T3 Code learned driving `agy acp` (`apps/server/src/provider/acp/Antigravity*.ts`) is marked
//! "(T3 Code)": an API failure is reported as text and `end_turn` and recorded as an error step in the
//! conversation's own database; a backgrounded command outlives its prompt and agy replies by itself
//! when it ends; a prompt can go silent.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use agent_client_protocol::schema::v1::{
    ContentBlock, InitializeResponse, McpServer, Meta, RequestPermissionRequest, SessionConfigKind, SessionConfigOption,
    SessionConfigOptionCategory, SessionConfigSelectOptions, SessionModeState, ToolCall as AcpToolCall, ToolCallUpdateFields, ToolKind,
};
use kybern_protocol::process::NoWindow;
use kybern_protocol::rpc::{Problem, ProblemAction, ProblemKind};
use kybern_protocol::*;
use serde_json::{Value, json};
use tokio::process::Command;

use super::stream::failed;
use super::{BRIDGE_AUTHORIZATION, BRIDGE_URL, EFFORTS, Scratch, tools};
use crate::acp::{
    self, AcpFlavor, Ask, ConfigSelection, ExtensionAsk, PermissionCard, Startup, ToolIdentity, rejects_arguments, stderr_text,
};
use crate::{DriverError, DriverEvent, NativeToolBridge, Result, SessionConfig};

/// `agy acp` steers a running turn with the next prompt from this version (T3 Code); Kybern uses ACP
/// only from here.
pub(crate) const MIN_ACP_VERSION: (u64, u64, u64) = (1, 5, 0);
/// Where Kybern keeps agy's own tool name in a tool call's `_meta`.
const TOOL_NAME: &str = "kybern/agyTool";
/// Where Kybern keeps a prompt answer's usage in its `_meta`.
const USAGE: &str = "kybern/agyUsage";
/// agy's step types in a conversation's `steps` table (T3 Code, `AntigravityTurnOutcome.ts`).
const ERROR_STEP: i64 = 17;
const PLANNER_RESPONSE_STEP: i64 = 15;
/// How much of an error step is read: the harness's text leads it, a Go stack trace follows.
const ERROR_PAYLOAD_BYTES: i64 = 16_384;
/// agy can leave a prompt open without updates; long tools and approvals pause this (T3 Code).
const INACTIVITY: Duration = Duration::from_secs(15 * 60);

/// Antigravity as an ACP flavor.
pub(crate) struct AgyAcp {
    /// The home whose `.gemini` holds the conversations (the transcript fallback and the error steps).
    home: Option<PathBuf>,
    /// `kybern mcp-bridge`'s endpoint and credential, for this session's process only.
    bridge_env: Vec<(&'static str, String)>,
    /// The log file and nothing else; removed with the session.
    scratch: Scratch,
    /// The start failed before agy answered `initialize`: the `-p` driver may take over.
    pub(crate) failed_to_start: Arc<AtomicBool>,
    /// Tool calls hidden from the transcript (agy reading its own MCP schema cache).
    hidden: std::sync::Mutex<HashSet<String>>,
    /// The last prompt answered `refusal`, agy's word for an exhausted quota (T3 Code).
    refused: AtomicBool,
    /// The prompt now open, from [`AcpFlavor::prompt_mark`] to [`AcpFlavor::prompt_outcome`].
    prompt: std::sync::Mutex<Option<OpenPrompt>>,
    /// Held text of a prompt that succeeded, for [`AcpFlavor::released_text`].
    released: std::sync::Mutex<String>,
}

/// What Kybern keeps of an open prompt to tell agy's failures from its answer.
struct OpenPrompt {
    session_id: String,
    /// The conversation's last step before the prompt.
    mark: i64,
    /// The conversation's database, open for the prompt's chunks once it exists.
    db: Option<rusqlite::Connection>,
    /// A warning-shaped chunk (`⚠ …`) agy hasn't recorded an error step for: shown once the turn
    /// succeeds or more text follows, never next to the failure it may turn out to be.
    held: String,
    /// The text of chunks withheld as a failure's words, for the failure's detail.
    failure_text: String,
}

/// The most of a withheld failure's text kept for its detail.
const FAILURE_TEXT_BYTES: usize = 16_384;

impl AgyAcp {
    pub(crate) fn new(home: Option<PathBuf>, bridge: Option<&NativeToolBridge>) -> Result<Self> {
        let bridge_env = match bridge {
            Some(NativeToolBridge { endpoint: Some(endpoint), authorization: Some(authorization), .. }) => {
                vec![(BRIDGE_URL, endpoint.clone()), (BRIDGE_AUTHORIZATION, authorization.clone())]
            }
            _ => Vec::new(),
        };
        Ok(Self {
            home,
            bridge_env,
            scratch: Scratch::new()?,
            failed_to_start: Arc::new(AtomicBool::new(false)),
            hidden: std::sync::Mutex::new(HashSet::new()),
            refused: AtomicBool::new(false),
            prompt: std::sync::Mutex::new(None),
            released: std::sync::Mutex::new(String::new()),
        })
    }

    fn lock_prompt(&self) -> std::sync::MutexGuard<'_, Option<OpenPrompt>> {
        self.prompt.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// On ACP agy reports a failure as chat text and `end_turn`, recording an error step first (seen on
    /// agy 1.5.14: the step is in the database when the chunk arrives). That text is the failure's, which
    /// [`AcpFlavor::prompt_outcome`] shows as a problem: the chunk is withheld so it isn't shown twice.
    /// A `⚠` chunk with no error step yet is held until the turn's end decides. Returns the chunk's text
    /// to send in its place (`Some("")` withholds it).
    fn screen_chunk(&self, session_id: &str, text: &str) -> Option<String> {
        let mut open = self.lock_prompt();
        let prompt = open.as_mut().filter(|prompt| prompt.session_id == session_id)?;
        if prompt.db.is_none() {
            prompt.db = self.conversation_db(session_id).filter(|db| db.exists()).and_then(|db| open_read_only(&db));
        }
        if prompt.db.as_ref().is_some_and(|db| newest_is_error(db, prompt.mark)) {
            let held = std::mem::take(&mut prompt.held);
            push_bounded(&mut prompt.failure_text, &held);
            push_bounded(&mut prompt.failure_text, text);
            return Some(String::new());
        }
        if text.trim_start().starts_with('\u{26a0}') {
            prompt.held.push_str(text);
            return Some(String::new());
        }
        // More text after a held warning: it was part of the answer.
        (!prompt.held.is_empty()).then(|| std::mem::take(&mut prompt.held) + text)
    }

    /// This conversation's own database, when its id is a plain one.
    fn conversation_db(&self, session_id: &str) -> Option<PathBuf> {
        if !super::valid_conversation_id(session_id) {
            return None;
        }
        Some(self.home.as_ref()?.join(".gemini/antigravity-cli/conversations").join(format!("{session_id}.db")))
    }
}

/// `agy acp`'s arguments.
pub(crate) fn launch_args(log_file: &Path) -> Vec<std::ffi::OsString> {
    vec!["acp".into(), "--log-file".into(), log_file.into()]
}

impl AcpFlavor for AgyAcp {
    type Completion = std::convert::Infallible;
    const KIND: ProviderKind = ProviderKind::Antigravity;
    const NAME: &'static str = "Antigravity";
    // agy answers `session/load` once it has replayed the conversation.
    const REPLAY_IDLE: Option<Duration> = None;
    const LOAD_TIMEOUT: Option<Duration> = Some(Duration::from_secs(180));
    // The guide rides on the first prompt unless the system prompt takes it.
    const CARRIES_GUIDE: bool = true;
    // agy stays in `default` (or its own `auto`) and Kybern answers from the live mode.
    const POLICY_FOLLOWS_MODE: bool = true;
    const STEER_FALLBACK: bool = true;
    const COMPACT: Option<&'static str> = Some("/compact");
    const REWRITES_INCOMING: bool = true;
    // As on `-p`, a model or effort picked during a turn applies to the next one.
    const CONFIG_AT_NEXT_PROMPT: bool = true;
    const BACKGROUND_REPLIES: bool = true;
    const INACTIVITY_LIMIT: Option<Duration> = Some(INACTIVITY);
    // A crashed agy ends the session; the daemon resumes the conversation in a new one.
    const ENDS_WITH_PROCESS: bool = true;

    fn command(&self, bin: &Path, config: &SessionConfig) -> Command {
        let mut command = crate::binary::command(bin).no_window();
        command.args(launch_args(&self.scratch.log_file()));
        for (key, value) in &config.env {
            if key != BRIDGE_URL && key != BRIDGE_AUTHORIZATION {
                command.env(key, value);
            }
        }
        // The bridge process agy starts inherits these; without them it serves no tools.
        command.env_remove(BRIDGE_URL).env_remove(BRIDGE_AUTHORIZATION);
        for (key, value) in &self.bridge_env {
            command.env(key, value);
        }
        crate::no_browser::quiet(&mut command, &config.env.iter().map(|(k, v)| (k.clone(), v.clone())).collect());
        command
    }

    fn startup_error(&self, step: Startup, detail: &str, stderr: &str) -> DriverError {
        if matches!(step, Startup::Launch | Startup::Initialize) {
            self.failed_to_start.store(true, Ordering::SeqCst);
        }
        DriverError::problem(startup_problem(step, detail, stderr))
    }

    fn exited_during_startup(&self, stderr: &std::sync::Mutex<String>) -> DriverError {
        self.failed_to_start.store(true, Ordering::SeqCst);
        let stderr = stderr_text(stderr);
        let detail = if stderr.is_empty() {
            "agy acp exited during startup".to_string()
        } else {
            format!("agy acp exited during startup: {stderr}")
        };
        DriverError::problem(startup_problem(Startup::Launch, &detail, &stderr))
    }

    fn mcp_servers(&self, bridge: Option<&NativeToolBridge>) -> Result<Vec<McpServer>> {
        // Kybern's tools reach agy through its one global `kybern mcp-bridge` entry (the environment
        // above), as on `-p`: a session server too would list every tool twice.
        if let Some(bridge) = bridge {
            bridge.validate()?;
        }
        Ok(Vec::new())
    }

    fn system_prompt_meta(&self, init: &InitializeResponse, guide: &str) -> Option<Meta> {
        appends_system_prompt(init).then(|| {
            let mut meta = Meta::new();
            meta.insert("antigravity".into(), json!({ "systemPrompt": { "append": guide } }));
            meta
        })
    }

    fn session_mode(&self, mode: PermissionMode) -> Option<&'static str> {
        self.session_mode_in(mode, None)
    }

    fn session_mode_in(&self, mode: PermissionMode, modes: Option<&SessionModeState>) -> Option<&'static str> {
        Some(session_mode(mode, modes))
    }

    fn steers_with_prompt(&self, init: &InitializeResponse) -> bool {
        init.agent_info.as_ref().is_some_and(|info| crate::binary::at_least(&info.version, MIN_ACP_VERSION))
    }

    fn config_selection(&self, model: Option<&str>, effort: Option<&str>, options: &[SessionConfigOption]) -> Option<ConfigSelection> {
        Some(config_selection(model, effort, options))
    }

    fn blocks(&self, message: &UserMessage) -> Vec<ContentBlock> {
        acp::merge_text_blocks(acp::prompt_blocks(message))
    }

    fn rewrite_incoming(&self, message: &mut Value) {
        if message.get("method").and_then(Value::as_str) == Some("session/update")
            && message.pointer("/params/update/sessionUpdate").and_then(Value::as_str) == Some("agent_message_chunk")
            && let Some(text) = message.pointer("/params/update/content/text").and_then(Value::as_str)
            && let Some(session_id) = message.pointer("/params/sessionId").and_then(Value::as_str)
            && let Some(replacement) = self.screen_chunk(session_id, text)
        {
            match message.pointer_mut("/params/update") {
                Some(update) if replacement.is_empty() => *update = json!({ "sessionUpdate": "session_info_update" }),
                Some(update) => update["content"]["text"] = json!(replacement),
                None => {}
            }
        }
        rewrite(message, &self.hidden, &self.refused);
    }

    fn released_text(&self) -> Option<String> {
        let held = std::mem::take(&mut *self.released.lock().unwrap_or_else(|poisoned| poisoned.into_inner()));
        (!held.is_empty()).then_some(held)
    }

    fn turn_usage(&self, meta: Option<&Meta>) -> (Usage, Option<f64>) {
        (prompt_usage(meta.and_then(|meta| meta.get(USAGE))), None)
    }

    fn prompt_failure(&self, error: &agent_client_protocol::Error) -> DriverEvent {
        prompt_failure(error)
    }

    fn tool_identity(&self, kind: &ToolKind, title: &str, meta: Option<&Meta>, raw_input: Option<&Value>) -> ToolIdentity {
        let (name, input) = self.normalized(kind, title, meta, raw_input);
        ToolIdentity { name, mcp_arguments: Some(input) }
    }

    fn tool_call(&self, call: &AcpToolCall) -> (String, Value) {
        self.normalized(&call.kind, &call.title, call.meta.as_ref(), call.raw_input.as_ref())
    }

    fn tool_output(&self, status: Option<&str>, fields: ToolCallUpdateFields) -> (Value, bool) {
        tool_output(status, &fields)
    }

    fn permission_card(&self, request: &RequestPermissionRequest) -> PermissionCard {
        let fields = &request.tool_call.fields;
        let title = fields.title.clone().unwrap_or_default();
        let (name, mut input) =
            self.normalized(&fields.kind.unwrap_or(ToolKind::Other), &title, request.tool_call.meta.as_ref(), fields.raw_input.as_ref());
        if let Value::Object(map) = &mut input {
            map.insert("title".into(), json!(title));
            map.insert("locations".into(), json!(fields.locations));
            map.insert("options".into(), json!(acp::option_list(&request.options)));
        }
        PermissionCard { tool_name: name, input, summary: title }
    }

    fn permission_question(&self, request: &RequestPermissionRequest) -> Option<Box<dyn ExtensionAsk>> {
        AgyQuestion::parse(request).map(|question| Box::new(question) as Box<dyn ExtensionAsk>)
    }

    fn tool_outlives_prompt(&self, call: &AcpToolCall) -> bool {
        outlives_prompt(call)
    }

    fn silent_failure() -> DriverEvent {
        let detail = format!("agy acp sent nothing for {} minutes while a prompt was open", INACTIVITY.as_secs() / 60);
        let problem = Problem::new(ProblemKind::Internal, detail)
            .with_subject("antigravity")
            .with_copy("Antigravity stopped responding", "Send your message again to continue.")
            .with_action(ProblemAction::retry("Try again"));
        DriverEvent::TurnFailed { error: "Antigravity stopped responding. Send your message again.".into(), problem: Some(problem) }
    }

    fn prompt_mark(&self, session_id: &str) -> Option<i64> {
        self.refused.store(false, Ordering::SeqCst);
        *self.lock_prompt() = None;
        let db = self.conversation_db(session_id)?;
        // A conversation without its database yet starts from nothing.
        let mark = if db.exists() { last_step_index(&db)? } else { -1 };
        let prompt = OpenPrompt { session_id: session_id.into(), mark, db: None, held: String::new(), failure_text: String::new() };
        *self.lock_prompt() = Some(prompt);
        Some(mark)
    }

    fn prompt_outcome(&self, session_id: &str, mark: Option<i64>, event: DriverEvent) -> DriverEvent {
        let refused = self.refused.swap(false, Ordering::SeqCst);
        if !matches!(event, DriverEvent::TurnCompleted { stop_reason: StopReason::Completed, .. }) {
            // Stopped or failed: what was held goes with it.
            *self.lock_prompt() = None;
            return event;
        }
        let step = mark.and_then(|mark| self.conversation_db(session_id).and_then(|db| steps_after(&db, mark)));
        let outcome = match step {
            Some(StepsAfter { error: Some(text), reached_model, .. }) => failed(&text, reached_model),
            step if refused => {
                // The reset time rides in agy's quota error: its error step, else the words it sent.
                let words = self.lock_prompt().as_mut().map(|prompt| prompt.failure_text.clone() + &prompt.held).unwrap_or_default();
                let detail = step
                    .and_then(|step| step.last_error)
                    .or_else(|| (!words.trim().is_empty()).then(|| words.trim().to_string()))
                    .unwrap_or_else(|| "session/prompt answered stopReason \"refusal\" (QUOTA_EXHAUSTED)".into());
                DriverEvent::TurnFailed {
                    error: "You have reached your Antigravity quota for this period.".into(),
                    problem: Some(crate::failure::rate_limited_problem(ProviderKind::Antigravity, &detail)),
                }
            }
            _ => event,
        };
        // A failure's held words are its own; a success shows them (`released_text`). Replies agy starts
        // by itself after this are no prompt's: nothing screens them.
        let open = self.lock_prompt().take();
        if matches!(outcome, DriverEvent::TurnCompleted { .. })
            && let Some(open) = open
        {
            *self.released.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = open.held;
        }
        outcome
    }
}

impl AgyAcp {
    /// A tool call as Kybern names it: agy's own name (kept by the rewrite) through the same mapping
    /// as `-p`, with the transcript's arguments when the input is too thin.
    fn normalized(&self, kind: &ToolKind, title: &str, meta: Option<&Meta>, raw_input: Option<&Value>) -> (String, Value) {
        let params = raw_input.cloned().unwrap_or(Value::Null);
        match meta.and_then(|meta| meta.get(TOOL_NAME)).and_then(Value::as_str) {
            Some(name) => tools::normalize(name, &params, |_| None),
            None => {
                let mut input = match &params {
                    Value::Object(map) => map.clone(),
                    _ => serde_json::Map::new(),
                };
                input.insert("raw".into(), params);
                (acp::tool_name(kind, title), Value::Object(input))
            }
        }
    }
}

/// Whether agy takes Kybern's guide in its system prompt.
fn appends_system_prompt(init: &InitializeResponse) -> bool {
    init.agent_capabilities.meta.as_ref().and_then(|meta| meta.get("antigravity")).and_then(|agy| agy.pointer("/systemPrompt/append"))
        == Some(&Value::Bool(true))
}

/// The ACP mode a Kybern mode runs agy in. agy asks before acting in `default`, and Kybern answers from
/// the live mode: Supervised asks, Accept edits allows the workspace's edits (the shared path check),
/// Full access allows everything. Auto is agy's own Auto review when the session offers it, whose asks
/// reach the user; otherwise it stays in `default` and asks (T3 Code, `antigravitySessionMode`).
pub(crate) fn session_mode(mode: PermissionMode, modes: Option<&SessionModeState>) -> &'static str {
    let offers_auto = modes.is_some_and(|modes| modes.available_modes.iter().any(|offered| offered.id.0.as_ref() == "auto"));
    match mode {
        PermissionMode::Auto if offers_auto => "auto",
        _ => "default",
    }
}

/// The values of a select option, groups flattened.
fn select_values(option: &SessionConfigOption) -> Vec<String> {
    match &option.kind {
        SessionConfigKind::Select(select) => match &select.options {
            SessionConfigSelectOptions::Ungrouped(options) => options.iter().map(|option| option.value.0.to_string()).collect(),
            SessionConfigSelectOptions::Grouped(groups) => {
                groups.iter().flat_map(|group| group.options.iter().map(|option| option.value.0.to_string())).collect()
            }
            _ => Vec::new(),
        },
        _ => Vec::new(),
    }
}

/// agy's thinking option: the one in category `thought_level` (T3 Code, `antigravityThinkingConfig`).
fn thinking_option(options: &[SessionConfigOption]) -> Option<&SessionConfigOption> {
    options.iter().find(|option| matches!(option.category, Some(SessionConfigOptionCategory::ThoughtLevel)))
}

fn model_option(options: &[SessionConfigOption]) -> Option<&SessionConfigOption> {
    options.iter().find(|option| option.id.0.as_ref() == "model" || matches!(option.category, Some(SessionConfigOptionCategory::Model)))
}

/// The writes that run Kybern's model (a tier slug, `gemini-3.8-flash-high`, as `agy models` lists it)
/// at an effort: the family through `model` and the tier through the thinking option. The effort picks
/// the tier, and an effort the family has no tier for keeps the slug's own, as `-p`'s `turn_model` does.
/// A model agy doesn't list as a family is passed as it is (agy still takes the old slugs, T3 Code).
pub(crate) fn config_selection(model: Option<&str>, effort: Option<&str>, options: &[SessionConfigOption]) -> ConfigSelection {
    let families = model_option(options).map(select_values).unwrap_or_default();
    let model_id = model_option(options).map_or_else(|| "model".to_string(), |option| option.id.0.to_string());
    let thinking = thinking_option(options);
    let levels = thinking.map(select_values).unwrap_or_default();
    let level_for = |held: Option<&str>| -> Option<String> {
        effort.filter(|effort| levels.iter().any(|level| level == effort)).or(held).map(str::to_string)
    };
    let mut writes = Vec::new();
    let Some(model) = model else {
        if let (Some(thinking), Some(level)) = (thinking, level_for(None)) {
            writes.push((thinking.id.0.to_string(), level));
        }
        return ConfigSelection { writes, model: None };
    };
    if families.iter().any(|family| family == model) {
        writes.push((model_id, model.to_string()));
        let level = level_for(None);
        if let (Some(thinking), Some(level)) = (thinking, &level) {
            writes.push((thinking.id.0.to_string(), level.clone()));
        }
        return ConfigSelection { writes, model: Some(model.to_string()) };
    }
    // A tier slug: the longest family it extends with a tier.
    let tiered = families
        .iter()
        .filter_map(|family| {
            let tier = model.strip_prefix(family.as_str())?.strip_prefix('-')?;
            EFFORTS.contains(&tier).then_some((family, tier))
        })
        .max_by_key(|(family, _)| family.len());
    match (tiered, thinking) {
        (Some((family, held)), Some(thinking)) => {
            let level = level_for(Some(held)).unwrap_or_else(|| held.to_string());
            writes.push((model_id, family.clone()));
            writes.push((thinking.id.0.to_string(), level.clone()));
            ConfigSelection { writes, model: Some(format!("{family}-{level}")) }
        }
        _ => {
            writes.push((model_id, model.to_string()));
            ConfigSelection { writes, model: Some(model.to_string()) }
        }
    }
}

/// Move what ACP's types would drop into `_meta`: agy's own tool name on tool calls (in updates and in
/// permission requests) and a prompt answer's `usage`. agy reading its own MCP schema cache is not the
/// user's work: those calls become updates no one shows.
fn rewrite(message: &mut Value, hidden: &std::sync::Mutex<HashSet<String>>, refused: &AtomicBool) {
    let lock = || hidden.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    match message.get("method").and_then(Value::as_str) {
        Some("session/update") => {
            let Some(update) = message.pointer_mut("/params/update") else { return };
            let kind = update.get("sessionUpdate").and_then(Value::as_str);
            if !matches!(kind, Some("tool_call" | "tool_call_update")) {
                return;
            }
            let id = update.get("toolCallId").and_then(Value::as_str).unwrap_or_default().to_string();
            if keep_tool_name(update) {
                lock().insert(id.clone());
            }
            if lock().contains(&id) {
                // Nothing a client shows; a completed one closes nothing open either.
                *update = json!({ "sessionUpdate": "session_info_update" });
            }
        }
        Some("session/request_permission") => {
            if let Some(call) = message.pointer_mut("/params/toolCall") {
                keep_tool_name(call);
            }
        }
        None if message.pointer("/result/stopReason").is_some() => {
            let Some(result) = message.get_mut("result").and_then(Value::as_object_mut) else { return };
            if result.get("stopReason").and_then(Value::as_str) == Some("refusal") {
                refused.store(true, Ordering::SeqCst);
                // The quota is told from this flag; the turn itself ended normally.
                result.insert("stopReason".into(), json!("end_turn"));
            }
            if let Some(usage) = result.remove("usage") {
                let meta = result.entry("_meta").or_insert_with(|| json!({}));
                if let Value::Object(meta) = meta {
                    meta.insert(USAGE.into(), usage);
                }
            }
        }
        _ => {}
    }
}

/// Put a tool call's agy name into its `_meta`. Returns whether it is agy reading its own MCP schema.
fn keep_tool_name(call: &mut Value) -> bool {
    let Some(name) = call.get("name").and_then(Value::as_str).map(str::to_string) else { return false };
    let input = call.get("rawInput").or_else(|| call.get("args")).cloned().unwrap_or(Value::Null);
    let meta = call.as_object_mut().map(|call| call.entry("_meta").or_insert_with(|| json!({})));
    if let Some(Value::Object(meta)) = meta {
        meta.insert(TOOL_NAME.into(), json!(name));
    }
    let (kybern_name, input) = tools::normalize(&name, &input, |_| None);
    tools::reads_own_mcp_schema(&kybern_name, &input)
}

/// A prompt answer's usage, mapped as `-p`'s per-step usage is: input as reported (it leaves out cache
/// reads, which are their own count) and output as reported (it already counts thinking).
pub(crate) fn prompt_usage(usage: Option<&Value>) -> Usage {
    let Some(usage) = usage else { return Usage::default() };
    let number = |key: &str| usage.get(key).and_then(Value::as_u64).unwrap_or(0);
    Usage {
        input_tokens: number("inputTokens"),
        output_tokens: number("outputTokens"),
        cache_read_tokens: number("cachedReadTokens"),
        cache_write_tokens: number("cachedWriteTokens"),
    }
}

/// A finished tool call as `-p` reports it: its output as text, failed when its state, its exit code or
/// its text says so.
fn tool_output(status: Option<&str>, fields: &ToolCallUpdateFields) -> (Value, bool) {
    let raw = fields.raw_output.as_ref();
    let mut text = raw.and_then(|raw| raw.get("output")).and_then(Value::as_str).map(str::to_string).unwrap_or_default();
    if text.is_empty() {
        let content = serde_json::to_value(&fields.content).unwrap_or(Value::Null);
        let texts: Vec<&str> =
            content.as_array().into_iter().flatten().filter_map(|item| item.pointer("/content/text").and_then(Value::as_str)).collect();
        text = texts.join("\n");
    }
    if text.is_empty() {
        text = raw
            .and_then(|raw| raw.get("error"))
            .and_then(|error| error.as_str().or_else(|| error.get("message")?.as_str()))
            .unwrap_or("")
            .into();
    }
    let exit_code = raw.and_then(|raw| raw.get("exit_code").or_else(|| raw.get("exitCode"))).and_then(Value::as_i64);
    let is_error = status == Some("failed") || exit_code.is_some_and(|code| code != 0) || tools::exited_nonzero(&text);
    (Value::String(text), is_error)
}

/// A command (not a daemon) or a scheduled wake goes on after its prompt answers (T3 Code,
/// `antigravityToolOutlivesPrompt`).
fn outlives_prompt(call: &AcpToolCall) -> bool {
    if matches!(call.title.as_str(), "Run schedule" | "Running schedule") {
        return true;
    }
    let daemon = call.raw_input.as_ref().and_then(|input| input.get("IsDaemon")).and_then(Value::as_bool) == Some(true);
    call.kind == ToolKind::Execute && !daemon
}

/// A failed `session/prompt`, in the words `-p` uses for the same text.
fn prompt_failure(error: &agent_client_protocol::Error) -> DriverEvent {
    let text = error.to_string();
    let lower = text.to_ascii_lowercase();
    // The connection went with the process: the daemon respawns it on the next message.
    if ["connection closed", "broken pipe", "channel closed", "server shut down", "transport"].iter().any(|needle| lower.contains(needle)) {
        let problem = Problem::new(ProblemKind::Internal, text)
            .with_subject("antigravity")
            .with_copy("Antigravity stopped unexpectedly", "Send your message again to continue. This thread's work is safe.")
            .with_action(ProblemAction::retry("Try again"));
        return DriverEvent::TurnFailed {
            error: "Antigravity stopped unexpectedly. Send your message again.".into(),
            problem: Some(problem),
        };
    }
    failed(&text, false)
}

/// What a failed start means: an `agy` that doesn't know an option needs an update, a cause
/// `failure::classify` names (signed out, offline, a limit), or else the step that failed.
fn startup_problem(step: Startup, detail: &str, stderr: &str) -> Problem {
    let kind = ProviderKind::Antigravity;
    if matches!(step, Startup::Launch | Startup::Initialize) && rejects_arguments(stderr) {
        return crate::failure::update_needed_problem(kind, detail);
    }
    if let Some(problem) = crate::failure::classify(kind, detail) {
        return problem;
    }
    const CHECK: &str = "Check that Antigravity is signed in (Settings → Agents → Antigravity), then try again.";
    let (title, hint) = match step {
        Startup::Launch => ("Antigravity quit while starting", CHECK),
        Startup::Initialize => ("Antigravity didn't start", CHECK),
        Startup::NewSession => ("Antigravity couldn't start a conversation", CHECK),
        Startup::Resume => ("Antigravity couldn't reopen this conversation", "Try again, or start a new thread if it keeps happening."),
        Startup::ResumeTimedOut => (
            "Antigravity didn't reopen this conversation",
            "It didn't answer in time. Try again, or start a new thread if it keeps happening.",
        ),
    };
    Problem::new(ProblemKind::Internal, detail)
        .with_subject("antigravity")
        .with_copy(title, hint)
        .with_action(ProblemAction::retry("Try again"))
}

/// agy's own question to the user, sent as a permission request whose tool call id starts with
/// `interaction_` and whose options are the answers (T3 Code, `isAntigravityUserInputRequest`). Shown as a
/// question card, never answered by Kybern itself.
struct AgyQuestion {
    tool_call_id: String,
    question: String,
    options: Vec<(String, String)>,
}

impl AgyQuestion {
    fn parse(request: &RequestPermissionRequest) -> Option<Self> {
        let tool_call_id = request.tool_call.tool_call_id.to_string();
        if !tool_call_id.starts_with("interaction_") || request.options.is_empty() {
            return None;
        }
        let question =
            request.tool_call.fields.title.as_deref().map(str::trim).filter(|title| !title.is_empty()).unwrap_or("Choose an option.");
        let options = request
            .options
            .iter()
            .map(|option| {
                let label = if option.name.trim().is_empty() { option.option_id.to_string() } else { option.name.trim().to_string() };
                (option.option_id.to_string(), label)
            })
            .collect();
        Some(Self { tool_call_id, question: question.to_string(), options })
    }
}

impl ExtensionAsk for AgyQuestion {
    fn kind(&self) -> Ask {
        Ask::Question
    }

    fn card(&self, request_id: String) -> DriverEvent {
        let options: Vec<Value> = self.options.iter().map(|(_, label)| json!({ "label": label })).collect();
        DriverEvent::PermissionRequest {
            request_id,
            tool_call_id: Some(self.tool_call_id.clone()),
            tool_name: "AskUserQuestion".into(),
            input: json!({ "questions": [{ "question": self.question, "options": options, "multiSelect": false }] }),
            summary: self.question.clone(),
            suggestions: vec![],
        }
    }

    fn response(&self, decision: Option<ApprovalDecision>) -> Value {
        let cancelled = json!({ "outcome": { "outcome": "cancelled" } });
        let Some(ApprovalDecision::Submit { response }) = decision else { return cancelled };
        let answer = match response.pointer("/answers").and_then(|answers| answers.get(&self.question)) {
            Some(Value::String(answer)) => answer.trim().to_string(),
            Some(Value::Array(answers)) => answers.first().and_then(Value::as_str).unwrap_or("").trim().to_string(),
            _ => return cancelled,
        };
        match self.options.iter().find(|(id, label)| *label == answer || *id == answer) {
            Some((id, _)) => json!({ "outcome": { "outcome": "selected", "optionId": id } }),
            None => cancelled,
        }
    }
}

/// The last step index in a conversation's database.
fn last_step_index(db: &Path) -> Option<i64> {
    let conn = open_read_only(db)?;
    conn.query_row("SELECT coalesce(max(idx), -1) FROM steps", [], |row| row.get(0)).ok()
}

/// What a prompt added to its conversation's record.
#[derive(Debug, PartialEq)]
pub(crate) struct StepsAfter {
    /// The text of the error step that ends it, if it ends with one.
    pub(crate) error: Option<String>,
    /// The model answered within this prompt.
    pub(crate) reached_model: bool,
    /// The text of the last error step within this prompt, wherever it is.
    pub(crate) last_error: Option<String>,
}

/// The steps after `mark`: whether the last one is an error (and its text), and whether the model answered.
pub(crate) fn steps_after(db: &Path, mark: i64) -> Option<StepsAfter> {
    let conn = open_read_only(db)?;
    let (step_type, payload): (i64, Option<Vec<u8>>) = conn
        .query_row(
            "SELECT step_type, substr(step_payload, 1, ?1) FROM steps WHERE idx > ?2 ORDER BY idx DESC LIMIT 1",
            rusqlite::params![ERROR_PAYLOAD_BYTES, mark],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok()?;
    let reached_model = conn
        .query_row("SELECT 1 FROM steps WHERE idx > ?1 AND step_type = ?2 LIMIT 1", rusqlite::params![mark, PLANNER_RESPONSE_STEP], |_| {
            Ok(())
        })
        .is_ok();
    let error = (step_type == ERROR_STEP).then(|| payload_text(&payload.unwrap_or_default()));
    let last_error = match &error {
        Some(error) => Some(error.clone()),
        None => conn
            .query_row(
                "SELECT substr(step_payload, 1, ?1) FROM steps WHERE idx > ?2 AND step_type = ?3 ORDER BY idx DESC LIMIT 1",
                rusqlite::params![ERROR_PAYLOAD_BYTES, mark, ERROR_STEP],
                |row| row.get::<_, Option<Vec<u8>>>(0),
            )
            .ok()
            .map(|payload| payload_text(&payload.unwrap_or_default())),
    };
    Some(StepsAfter { error, reached_model, last_error })
}

/// Whether the newest step after `mark` is an error step.
fn newest_is_error(conn: &rusqlite::Connection, mark: i64) -> bool {
    conn.query_row("SELECT step_type FROM steps WHERE idx > ?1 ORDER BY idx DESC LIMIT 1", [mark], |row| row.get::<_, i64>(0))
        .is_ok_and(|step_type| step_type == ERROR_STEP)
}

/// `text` added to `into`, which keeps at most [`FAILURE_TEXT_BYTES`].
fn push_bounded(into: &mut String, text: &str) {
    let room = FAILURE_TEXT_BYTES.saturating_sub(into.len());
    let mut end = room.min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    into.push_str(&text[..end]);
}

/// An error step's payload (protobuf) as the text it carries: control bytes and invalid UTF-8 become spaces.
pub(crate) fn payload_text(payload: &[u8]) -> String {
    let text = String::from_utf8_lossy(payload);
    let cleaned: String = text.chars().map(|c| if c == '\u{fffd}' || (c.is_control() && c != '\n') { ' ' } else { c }).collect();
    cleaned.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn open_read_only(db: &Path) -> Option<rusqlite::Connection> {
    let conn =
        rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX)
            .ok()?;
    let _ = conn.busy_timeout(Duration::from_millis(100));
    Some(conn)
}

/// Whether `agy acp` starts and answers `initialize` with a protocol version: the check that picks
/// ACP over `-p`. Nothing else is sent, so it never opens a conversation or a browser.
pub(crate) async fn initializes(bin: &Path, env: &BTreeMap<String, String>) -> bool {
    use tokio::io::AsyncWriteExt;
    let scratch = match Scratch::new() {
        Ok(scratch) => scratch,
        Err(_) => return false,
    };
    let mut command = crate::binary::command(bin).no_window();
    command
        .args(launch_args(&scratch.log_file()))
        .envs(env)
        .current_dir(scratch.0.as_path())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    crate::no_browser::quiet(&mut command, env);
    #[cfg(unix)]
    command.process_group(0);
    let Ok(mut child) = command.spawn() else { return false };
    let tree = child.id().map(crate::process_tree::ProcessTree::new);
    let check = async {
        let mut stdin = child.stdin.take()?;
        let stdout = child.stdout.take()?;
        let request = json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": 1, "clientCapabilities": {}, "clientInfo": { "name": "kybern", "version": env!("CARGO_PKG_VERSION") } }
        });
        stdin.write_all(format!("{request}\n").as_bytes()).await.ok()?;
        stdin.flush().await.ok()?;
        let mut lines = tokio::io::AsyncBufReadExt::lines(tokio::io::BufReader::new(stdout));
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
            if message.get("id") == Some(&json!(1)) {
                return Some(message.pointer("/result/protocolVersion").is_some());
            }
        }
        None
    };
    let ok = tokio::time::timeout(Duration::from_secs(20), check).await.ok().flatten().unwrap_or(false);
    let _ = child.start_kill();
    drop(tree);
    ok
}

#[cfg(test)]
#[path = "acp_tests.rs"]
mod tests;
