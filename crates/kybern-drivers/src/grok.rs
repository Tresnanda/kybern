//! Grok Build driver: ACP over stdio (`grok agent stdio`).
//!
//! A flavor of the shared ACP client (`crate::acp`), which owns the session; this file holds what is Grok's own.
//!
//! Seen from a real `grok` 1.0.92 (`grok --help`, `grok agent --help`, and `initialize` /
//! `session/new` without a login):
//! - `--permission-mode <default|acceptEdits|auto|dontAsk|bypassPermissions|plan>` and
//!   `--no-auto-update` are top-level options; `--always-approve` belongs to `agent`.
//! - `initialize` answers `promptCapabilities.image: true`, `loadSession: true`, and
//!   `_meta.modelState` with each model's `totalContextTokens` and `reasoningEfforts`.
//! - Grok reads `GROK_HOME` (it wrote its `config.toml`, `sessions/` and `logs/` there).
//! - `session/new` while signed out fails with `-32000 Authentication required`.
//!
//! Grok's own extension methods (`x.ai/…`, `_x.ai/…`) and the shapes of their params come from
//! T3 Code's Grok provider (`packages/provider-grok`), not from a recorded `grok` session; they are
//! marked "(T3 Code)" where they are used.

use std::path::{Path, PathBuf};
use std::time::Duration;

use agent_client_protocol::schema::v1::{
    ContentBlock, Meta, PermissionOption, RequestPermissionRequest, RequestPermissionResponse, ToolCallUpdateFields, ToolKind,
};
use async_trait::async_trait;
use kybern_protocol::process::NoWindow;
use kybern_protocol::rpc::{Problem, ProblemAction, ProblemKind};
use kybern_protocol::*;
use serde_json::{Map, Value, json};
use tokio::process::Command;

use crate::acp::{self, AcpFlavor, Ask, Extension, ExtensionAsk, Startup, ToolIdentity, rejects_arguments, stderr_text};
use crate::binary::{at_least, resolve, version_of};
use crate::{AgentDriver, DriverError, DriverEvent, ProbeContext, Result, SessionConfig, SpawnedSession};

/// Minimum Grok Build version that ships a stable `agent stdio` ACP mode.
const MIN_VERSION: (u64, u64, u64) = (0, 2, 0);

/// Keeps every short-lived `grok` (`--version`, `models`, `--help`) from starting Grok's updater.
/// Sessions also pass `--no-auto-update`.
pub const DISABLE_AUTOUPDATER: (&str, &str) = ("GROK_DISABLE_AUTOUPDATER", "1");

/// JSON-RPC error code Grok uses for a usage limit (T3 Code, `xAiRateLimitedErrorCode`).
const RATE_LIMITED: i32 = -32003;

/// Grok's only session-scoped "allow always" option; its other allow-always options save a grant
/// for the whole project (T3 Code, `grokApprovalOptions`).
const ALLOW_EDITS_SESSION: &str = "allow-edits-session";

pub struct GrokDriver;

impl GrokDriver {
    async fn probe_inner(&self, context: &ProbeContext) -> ProviderStatus {
        let kind = self.kind();
        let mut status = ProviderStatus {
            kind,
            display_name: kind.display_name().into(),
            available: false,
            binary_path: None,
            version: None,
            unavailable_reason: None,
            // Supervised and Accept edits launch Grok with `--permission-mode default` and answer its
            // `session/request_permission` (Kybern accepts workspace edits itself in Accept edits); Auto
            // is xAI's own classifier, which asks only for what it refuses; Full access is `--always-approve`.
            supported_permission_modes: PermissionMode::ALL.to_vec(),
            supports_fork: false,
            // The model is chosen at session start (setSessionConfigOption); `set_model` is not wired, so no live switch.
            supports_model_switch: false,
            supports_effort_switch: false,
            supported_efforts: vec![],
            models: vec![],
            instances: vec!["default".into()],
        };

        let bin = match resolve(kind, context.binary.as_ref()) {
            Ok(b) => b,
            Err(e) => {
                status.unavailable_reason = Some(format!("{e}. {}", install_hint()));
                return status;
            }
        };
        status.binary_path = Some(bin.display().to_string());

        match version_of(&bin, &["--version"]).await {
            Some(v) => {
                let ok = at_least(&v, MIN_VERSION);
                status.available = ok;
                status.version = Some(v.clone());
                if !ok {
                    status.unavailable_reason =
                        Some(format!("Grok Build {v} is older than the required {}.{}.{}", MIN_VERSION.0, MIN_VERSION.1, MIN_VERSION.2));
                }
                if ok {
                    status.models = discover_models(&bin, context).await;
                }
            }
            None => {
                status.unavailable_reason = Some("could not run `grok --version`".into());
            }
        }
        status
    }
}

/// Best-effort model list. Falls back to empty if the command is missing or fails.
async fn discover_models(bin: &std::path::Path, context: &ProbeContext) -> Vec<ProviderModel> {
    let mut cmd = Command::new(bin).no_window();
    cmd.args(["models"]).stdin(std::process::Stdio::null()).kill_on_drop(true);
    if let Some(cwd) = &context.cwd {
        cmd.current_dir(cwd);
    }
    for (k, v) in &context.env {
        cmd.env(k, v);
    }
    cmd.env(DISABLE_AUTOUPDATER.0, DISABLE_AUTOUPDATER.1);
    if let Some(grok_home) = grok_home_for_child(context.env.get("GROK_HOME").map(String::as_str)) {
        cmd.env("GROK_HOME", grok_home);
    }

    let output = tokio::time::timeout(std::time::Duration::from_secs(8), crate::process_tree::output(&mut cmd))
        .await
        .ok()
        .and_then(|r| r.ok())
        .filter(|o| o.status.success());

    let Some(output) = output else { return Vec::new() };
    parse_models(&String::from_utf8_lossy(&output.stdout))
}

/// `GROK_HOME` with a leading `~` expanded, from the provider's own environment or else the daemon's,
/// when it needs expanding: `grok` does not expand it itself.
fn grok_home_for_child(configured: Option<&str>) -> Option<PathBuf> {
    let inherited = std::env::var("GROK_HOME").ok();
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from);
    crate::binary::grok_home_override(home.as_deref(), configured.or(inherited.as_deref()))
}

/// How to get Grok Build when it is not installed. The shell installer is for macOS and Linux only.
fn install_hint() -> &'static str {
    if cfg!(windows) {
        "Install Grok Build from https://x.ai/cli, then restart Kybern."
    } else {
        "Install Grok Build: https://x.ai/cli (or `curl -fsSL https://x.ai/cli/install.sh | bash`)"
    }
}

/// The models in `grok models` output: one per line, the id first and anything after it (a
/// "(default)" marker, a description) optional. Headings, blank lines and separators are skipped.
fn parse_models(text: &str) -> Vec<ProviderModel> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            let starred = line.starts_with(['*', '>', '•']);
            let line = line.trim_start_matches(['*', '>', '•', '-', ' ']);
            let (id, rest) = line.split_once(char::is_whitespace).unwrap_or((line, ""));
            let id = id.trim_matches(['`', ',']);
            let first = id.chars().next()?;
            // Model ids look like `grok-4` or `grok-code-fast-1`; "Available models:" or "MODEL" do not.
            if !first.is_ascii_alphanumeric() || id.ends_with(':') || !id.contains(['-', '.']) && !id.chars().any(|c| c.is_ascii_digit()) {
                return None;
            }
            let rest = rest.trim();
            let marked_default = starred || rest.to_ascii_lowercase().contains("default");
            let description = rest.trim_matches(|c: char| c.is_whitespace() || matches!(c, '-' | '–' | '—' | ':')).to_string();
            Some(ProviderModel {
                id: id.to_string(),
                display_name: id.to_string(),
                resolved_id: None,
                description: (!description.is_empty()).then_some(description),
                provider: Some("xai".into()),
                efforts: vec![],
                default_effort: None,
                is_default: marked_default || id.contains("grok-build"),
                parameters: vec![],
                variants: vec![],
            })
        })
        .collect()
}

#[async_trait]
impl AgentDriver for GrokDriver {
    fn kind(&self) -> ProviderKind {
        ProviderKind::GrokBuild
    }

    async fn probe(&self, binary: Option<&PathBuf>) -> ProviderStatus {
        self.probe_inner(&ProbeContext { binary: binary.cloned(), ..ProbeContext::default() }).await
    }

    async fn probe_with_context(&self, context: &ProbeContext) -> ProviderStatus {
        self.probe_inner(context).await
    }

    async fn list_sessions(
        &self,
        _context: &ProbeContext,
        _cursor: Option<&str>,
        _query: &str,
    ) -> Result<kybern_protocol::methods::SessionsListResult> {
        Ok(kybern_protocol::methods::SessionsListResult { sessions: vec![], next_cursor: None })
    }

    async fn read_session(&self, _context: &ProbeContext, _id: &str) -> Result<crate::sessions::SessionHistory> {
        Err(DriverError::Unsupported("Grok Build session history is not implemented yet".into()))
    }

    async fn open_session_reader(&self, _context: &ProbeContext) -> Result<Box<dyn crate::sessions::SessionReader>> {
        Err(DriverError::Unsupported("Grok Build session reader is not implemented yet".into()))
    }

    async fn spawn(&self, config: SessionConfig) -> Result<SpawnedSession> {
        acp::spawn(Grok, config).await
    }
}

/// Grok Build as an ACP flavor.
struct Grok;

impl AcpFlavor for Grok {
    // Grok can leave `session/load` unanswered once it has replayed the conversation.
    const REPLAY_IDLE: Option<Duration> = Some(crate::acp::LOAD_REPLAY_IDLE);
    const LOAD_TIMEOUT: Option<Duration> = Some(crate::acp::LOAD_TIMEOUT);
    type Completion = PromptComplete;
    const KIND: ProviderKind = ProviderKind::GrokBuild;
    const NAME: &'static str = "Grok Build";
    // Grok has no system channel: the guide rides on the first ordinary prompt.
    const CARRIES_GUIDE: bool = true;
    // The mode is a launch flag (`--permission-mode`, `--always-approve`); Grok has no runtime switch.
    const NO_MODE_SWITCH: &'static str = "Grok Build permission mode cannot be changed after session start";
    const NO_MODEL_SWITCH: Option<&'static str> = Some("Grok Build model switch is not implemented yet");
    const NO_EFFORT_SWITCH: &'static str = "Grok Build does not expose effort switching over ACP";

    fn command(&self, bin: &Path, config: &SessionConfig) -> Command {
        let mut cmd = Command::new(bin).no_window();
        cmd.args(launch_args(config.permission_mode));
        for (k, v) in &config.env {
            cmd.env(k, v);
        }
        cmd.env(DISABLE_AUTOUPDATER.0, DISABLE_AUTOUPDATER.1);
        if let Some(grok_home) = grok_home_for_child(config.env.get("GROK_HOME").map(String::as_str)) {
            cmd.env("GROK_HOME", grok_home);
        }
        cmd
    }

    fn startup_error(&self, step: Startup, detail: &str, stderr: &str) -> DriverError {
        DriverError::problem(startup_problem(step, detail, stderr))
    }

    fn exited_during_startup(&self, stderr: &std::sync::Mutex<String>) -> DriverError {
        startup_exit_error(stderr)
    }

    fn initialize_meta(&self) -> Option<Meta> {
        Some(initialize_meta())
    }

    fn blocks(&self, message: &UserMessage) -> Vec<ContentBlock> {
        prompt_blocks(message)
    }

    // Grok echoes this id in `prompt_complete` (T3 Code sends it the same way).
    fn prompt_meta(&self, prompt_id: &str) -> Option<Meta> {
        let mut meta = Meta::new();
        meta.insert("promptId".into(), json!(prompt_id));
        meta.insert("requestId".into(), json!(prompt_id));
        Some(meta)
    }

    fn completion(&self, method: &str, params: &Value) -> Option<PromptComplete> {
        prompt_complete(method, params)
    }

    fn turn_usage(&self, meta: Option<&Meta>) -> (Usage, Option<f64>) {
        turn_usage(meta)
    }

    fn prompt_failure(&self, error: &agent_client_protocol::Error) -> DriverEvent {
        prompt_failure(error)
    }

    fn tool_identity(&self, kind: &ToolKind, title: &str, meta: Option<&Meta>, raw_input: Option<&Value>) -> ToolIdentity {
        let name = tool_name(kind, title, meta);
        match mcp_call(&name, raw_input) {
            Some((name, arguments)) => ToolIdentity { name, mcp_arguments: Some(arguments) },
            None => ToolIdentity { name, mcp_arguments: None },
        }
    }

    fn tool_output(&self, status: Option<&str>, fields: ToolCallUpdateFields) -> (Value, bool) {
        let content = serde_json::to_value(&fields.content).unwrap_or(Value::Null);
        tool_output(status, fields.raw_output, content, fields.title)
    }

    fn auto_permission(&self, mode: PermissionMode, request: &RequestPermissionRequest, cwd: &Path) -> Option<RequestPermissionResponse> {
        auto_response(mode, &request.tool_call.fields, cwd, &request.options)
    }

    fn permission_answer(
        &self,
        options: &[PermissionOption],
        decision: Option<&ApprovalDecision>,
    ) -> (RequestPermissionResponse, Option<String>) {
        permission_response(options, decision)
    }

    fn extension_request(&self, method: &str, params: &Value) -> Option<Extension> {
        XaiRequest::parse(method, params).map(|ask| Extension::Ask(Box::new(ask)))
    }
}

/// `grok`'s arguments for a permission mode. `--permission-mode` on the command line overrides Grok's
/// own config, so Supervised never inherits an `always-approve` the user set there (T3 Code,
/// `grokAcpSpawnArgs`). A launch `acceptEdits` behaves like ask in `grok agent` (T3 Code), so Accept
/// edits launches as Supervised and Kybern accepts the workspace edits itself.
fn launch_args(mode: PermissionMode) -> Vec<&'static str> {
    let mut args = vec!["--no-auto-update"];
    match mode {
        PermissionMode::FullAccess => args.extend(["agent", "--always-approve", "stdio"]),
        PermissionMode::Auto => args.extend(["--permission-mode", "auto", "agent", "stdio"]),
        PermissionMode::Supervised | PermissionMode::AcceptEdits => args.extend(["--permission-mode", "default", "agent", "stdio"]),
    }
    args
}

/// `initialize`'s `_meta`. A `generic` client (Grok's default) has Auto's refusals denied silently;
/// an `extension` client is asked, and gets no persistent command grants (T3 Code, `GROK_ACP_INITIALIZE_META`).
fn initialize_meta() -> Meta {
    let mut meta = Meta::new();
    meta.insert("clientType".into(), json!("extension"));
    meta
}

/// What Kybern tells Grok for a decision (see [`acp::permission_response`]). Allow for this thread
/// takes `allow-edits-session` only; Grok's other allow-always options would save a project grant
/// that outlives the thread.
fn permission_response(options: &[PermissionOption], decision: Option<&ApprovalDecision>) -> (RequestPermissionResponse, Option<String>) {
    acp::permission_response(Grok::NAME, Some(ALLOW_EDITS_SESSION), options, decision)
}

/// The answer Kybern sends without showing a card (see [`acp::auto_response`]).
fn auto_response(
    mode: PermissionMode,
    fields: &ToolCallUpdateFields,
    cwd: &Path,
    options: &[PermissionOption],
) -> Option<RequestPermissionResponse> {
    acp::auto_response(mode, fields, cwd, options, Some(ALLOW_EDITS_SESSION))
}

/// Grok's extension requests Kybern answers (T3 Code, `XAiAskUserQuestionRequest`,
/// `XAiExitPlanModeRequest`). Both come plain or wrapped as `{method, params}`.
#[derive(Debug, Clone, PartialEq)]
enum XaiRequest {
    AskUserQuestion { tool_call_id: Option<String>, questions: Vec<Value> },
    ExitPlanMode { tool_call_id: Option<String>, plan: Option<String> },
}

impl XaiRequest {
    fn parse(method: &str, params: &Value) -> Option<Self> {
        let params = params.get("params").filter(|_| params.get("method").is_some()).unwrap_or(params);
        let tool_call_id = params.get("toolCallId").and_then(Value::as_str).map(str::to_owned);
        match method.trim_start_matches('_') {
            "x.ai/ask_user_question" => Some(Self::AskUserQuestion {
                tool_call_id,
                questions: params.get("questions").and_then(Value::as_array).cloned().unwrap_or_default(),
            }),
            "x.ai/exit_plan_mode" => Some(Self::ExitPlanMode {
                tool_call_id,
                plan: params.get("planContent").and_then(Value::as_str).map(str::trim).filter(|plan| !plan.is_empty()).map(str::to_owned),
            }),
            _ => None,
        }
    }
}

impl ExtensionAsk for XaiRequest {
    // Questions and plans always reach the user, whatever the permission mode.
    fn kind(&self) -> Ask {
        match self {
            Self::AskUserQuestion { .. } => Ask::Question,
            Self::ExitPlanMode { .. } => Ask::Plan,
        }
    }

    /// The card Kybern shows: a question in the `AskUserQuestion` shape every client already reads, or
    /// the plan in the `ExitPlanMode` shape Claude's plan approvals use.
    fn card(&self, request_id: String) -> DriverEvent {
        match self {
            Self::AskUserQuestion { tool_call_id, questions } => {
                let questions: Vec<Value> = questions
                    .iter()
                    .filter_map(|question| {
                        let text = question.get("question").and_then(Value::as_str)?;
                        let options: Vec<Value> = question
                            .get("options")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                            .filter_map(|option| {
                                let label = option.get("label").and_then(Value::as_str)?;
                                let mut out = json!({ "label": label });
                                for key in ["description", "preview"] {
                                    if let Some(value) = option.get(key).and_then(Value::as_str) {
                                        out[key] = json!(value);
                                    }
                                }
                                Some(out)
                            })
                            .collect();
                        Some(json!({
                            "question": text,
                            "options": options,
                            "multiSelect": question.get("multiSelect").and_then(Value::as_bool).unwrap_or(false),
                        }))
                    })
                    .collect();
                let summary =
                    questions.first().and_then(|question| question["question"].as_str()).unwrap_or("Answer Grok's question").to_string();
                DriverEvent::PermissionRequest {
                    request_id,
                    tool_call_id: tool_call_id.clone(),
                    tool_name: "AskUserQuestion".into(),
                    input: json!({ "questions": questions }),
                    summary,
                    suggestions: vec![],
                }
            }
            Self::ExitPlanMode { tool_call_id, plan } => DriverEvent::PermissionRequest {
                request_id,
                tool_call_id: tool_call_id.clone(),
                tool_name: "ExitPlanMode".into(),
                input: plan.as_ref().map(|plan| json!({ "plan": plan })).unwrap_or_else(|| json!({})),
                summary: "Start implementing this plan?".into(),
                suggestions: vec![],
            },
        }
    }

    /// Grok's response to the user's decision.
    fn response(&self, decision: Option<ApprovalDecision>) -> Value {
        match self {
            Self::AskUserQuestion { questions, .. } => match decision {
                Some(ApprovalDecision::Submit { response }) => xai_answers(questions, &response),
                _ => json!({ "outcome": "cancelled" }),
            },
            Self::ExitPlanMode { .. } => match decision {
                Some(ApprovalDecision::AllowOnce | ApprovalDecision::AllowAlways) => json!({ "outcome": "approved" }),
                Some(ApprovalDecision::Deny { reason: Some(reason) }) if !reason.trim().is_empty() => {
                    json!({ "outcome": "request_changes", "feedback": reason.trim() })
                }
                _ => json!({
                    "outcome": "abandoned",
                    "feedback": "The user chose to keep planning. Stop here and wait for their feedback in a later message.",
                }),
            },
        }
    }
}

/// An `AskUserQuestion` answer (`{answers: {question: label | [labels]}, annotations}`) in xAI's shape:
/// `{outcome: "accepted", answers: {question: [labels]}, annotations: {question: {preview, notes}}}`.
/// Text that is not one of the question's options goes under "Other", with the text as a note (T3 Code,
/// `makeXAiAskUserQuestionResponse`).
fn xai_answers(questions: &[Value], response: &Value) -> Value {
    let mut answers = Map::new();
    let mut annotations = Map::new();
    for question in questions {
        let Some(text) = question.get("question").and_then(Value::as_str) else { continue };
        let values: Vec<String> = match response.pointer("/answers").and_then(|answers| answers.get(text)) {
            Some(Value::String(value)) => vec![value.clone()],
            Some(Value::Array(values)) => values.iter().filter_map(Value::as_str).map(str::to_owned).collect(),
            _ => Vec::new(),
        };
        let values: Vec<String> = values.into_iter().map(|value| value.trim().to_owned()).filter(|value| !value.is_empty()).collect();
        if values.is_empty() {
            continue;
        }
        let labels: Vec<&str> =
            question.get("options").and_then(Value::as_array).into_iter().flatten().filter_map(|o| o.get("label")?.as_str()).collect();
        let (chosen, custom): (Vec<String>, Vec<String>) = values.into_iter().partition(|value| labels.contains(&value.as_str()));
        let mut note =
            response.pointer("/annotations").and_then(|notes| notes.get(text)).and_then(Value::as_object).cloned().unwrap_or_default();
        if !custom.is_empty() {
            let mut notes: Vec<String> = custom;
            if let Some(existing) = note.get("notes").and_then(Value::as_str) {
                notes.push(existing.to_owned());
            }
            note.insert("notes".into(), json!(notes.join("\n")));
        }
        answers.insert(text.to_owned(), json!(if chosen.is_empty() { vec!["Other".to_owned()] } else { chosen }));
        if !note.is_empty() {
            annotations.insert(text.to_owned(), Value::Object(note));
        }
    }
    let mut out = json!({ "outcome": "accepted", "answers": answers });
    if !annotations.is_empty() {
        out["annotations"] = Value::Object(annotations);
    }
    out
}

/// Grok said a prompt finished without answering `session/prompt` (T3 Code, `xaiAcpExtension.ts`):
/// `x.ai/session/prompt_complete {sessionId, promptId, stopReason, agentResult}`, or a `turn_completed`
/// update on `x.ai/session_notification`. A background wake (`task-completed-…`) is not a prompt.
#[derive(Debug, Clone, PartialEq)]
struct PromptComplete {
    prompt_id: Option<String>,
    stop_reason: Option<String>,
    agent_result: Option<Value>,
}

impl acp::Completion for PromptComplete {
    fn prompt_id(&self) -> Option<&str> {
        self.prompt_id.as_deref()
    }

    fn event(&self, duration_ms: u64) -> DriverEvent {
        completion_event(self, duration_ms)
    }
}

fn prompt_complete(method: &str, params: &Value) -> Option<PromptComplete> {
    let text = |value: Option<&Value>| value.and_then(Value::as_str).map(str::trim).filter(|text| !text.is_empty()).map(str::to_owned);
    match method.trim_start_matches('_') {
        "x.ai/session/prompt_complete" => Some(PromptComplete {
            prompt_id: text(params.get("promptId")),
            stop_reason: text(params.get("stopReason")),
            agent_result: params.get("agentResult").filter(|value| !value.is_null()).cloned(),
        }),
        "x.ai/session_notification" | "x.ai/session/update" => {
            let update = params.get("update")?;
            if update.get("sessionUpdate").and_then(Value::as_str) != Some("turn_completed") {
                return None;
            }
            // Only a turn that names its prompt: background completions and other turns do not settle ours.
            let prompt_id = text(update.get("prompt_id")).or_else(|| text(update.get("promptId")))?;
            if prompt_id.starts_with("task-completed-") {
                return None;
            }
            Some(PromptComplete {
                prompt_id: Some(prompt_id),
                stop_reason: text(update.get("stop_reason")).or_else(|| text(update.get("stopReason"))),
                agent_result: update.get("agent_result").filter(|value| !value.is_null()).cloned(),
            })
        }
        _ => None,
    }
}

/// Grok's `agentResult` as the words for a failed turn, and all of it for details. A result that isn't
/// text is JSON: its `message` (or `error`) string is the words when it has one.
fn agent_result_text(result: Option<&Value>) -> (Option<String>, Option<String>) {
    let plain = |text: &str| Some(text.trim().to_owned()).filter(|text| !text.is_empty());
    match result {
        None => (None, None),
        Some(Value::String(text)) => (plain(text), plain(text)),
        Some(other) => {
            let message = ["/message", "/error", "/error/message", "/detail"]
                .iter()
                .find_map(|pointer| other.pointer(pointer).and_then(Value::as_str))
                .and_then(plain);
            (message, Some(other.to_string()))
        }
    }
}

/// The turn's end from Grok's own completion notice.
fn completion_event(complete: &PromptComplete, duration_ms: u64) -> DriverEvent {
    let (words, detail) = agent_result_text(complete.agent_result.as_ref());
    let stop = match complete.stop_reason.as_deref() {
        Some("rate_limit") => {
            let error = words.unwrap_or_else(|| "Grok Build reached its usage limit.".into());
            let problem = crate::failure::rate_limited_problem(ProviderKind::GrokBuild, detail.as_deref().unwrap_or(&error));
            return DriverEvent::TurnFailed { error, problem: Some(problem) };
        }
        Some("error") => {
            let error = words.unwrap_or_else(|| "Grok Build ended the turn with an error.".into());
            let detail = detail.unwrap_or_else(|| "x.ai/session/prompt_complete: stopReason \"error\" without an agentResult".into());
            let problem = crate::failure::classify(ProviderKind::GrokBuild, &detail).unwrap_or_else(|| {
                Problem::new(ProblemKind::Internal, detail)
                    .with_subject("grok")
                    .with_copy(
                        "Grok Build ended the turn with an error",
                        "Send your message again. If it keeps happening, copy the details and report them.",
                    )
                    .with_action(ProblemAction::retry("Try again"))
            });
            return DriverEvent::TurnFailed { error, problem: Some(problem) };
        }
        Some("cancelled") => StopReason::Interrupted,
        Some("max_tokens" | "max_turn_requests") => StopReason::MaxTurns,
        _ => StopReason::Completed,
    };
    DriverEvent::TurnCompleted { stop_reason: stop, usage: Usage::default(), cost_usd: None, duration_ms, anchors: Default::default() }
}

fn usage_limit_failure(error: String) -> DriverEvent {
    let problem = Some(crate::failure::rate_limited_problem(ProviderKind::GrokBuild, &error));
    DriverEvent::TurnFailed { error, problem }
}

/// A failed `session/prompt`: `-32003` is a usage limit whatever its text says.
fn prompt_failure(error: &agent_client_protocol::Error) -> DriverEvent {
    if i32::from(error.code) == RATE_LIMITED {
        return usage_limit_failure(error.to_string());
    }
    DriverEvent::turn_failed(ProviderKind::GrokBuild, error.to_string())
}

/// What a failed start means: an outdated `grok`, a cause `failure::classify` names (signed out, offline,
/// a usage limit), or else the step that failed. `detail` is the technical text, kept for Show details.
/// Only `grok`'s own `stderr` while it launches or initializes can say it rejected an option: an error a
/// later request answers with (`session/new`, `session/load`) is about that request, whatever its words.
fn startup_problem(step: Startup, detail: &str, stderr: &str) -> Problem {
    let kind = ProviderKind::GrokBuild;
    if matches!(step, Startup::Launch | Startup::Initialize) && rejects_arguments(stderr) {
        return crate::failure::update_needed_problem(kind, detail);
    }
    if let Some(problem) = crate::failure::classify(kind, detail) {
        return problem;
    }
    const CHECK: &str = "Check that Grok Build is signed in (run `grok login`), then try again.";
    let (title, hint) = match step {
        Startup::Launch => ("Grok Build quit while starting", CHECK),
        Startup::Initialize => ("Grok Build didn't start", CHECK),
        Startup::NewSession => ("Grok Build couldn't start a conversation", CHECK),
        Startup::Resume => ("Grok Build couldn't reopen this conversation", "Try again, or start a new thread if it keeps happening."),
        Startup::ResumeTimedOut => (
            "Grok Build didn't reopen this conversation",
            "It didn't answer in time. Try again, or start a new thread if it keeps happening.",
        ),
    };
    Problem::new(ProblemKind::Internal, detail).with_subject("grok").with_copy(title, hint).with_action(ProblemAction::retry("Try again"))
}

/// `grok` quit before the session was bound; its stderr says why.
fn startup_exit_error(tail: &std::sync::Mutex<String>) -> DriverError {
    let stderr = stderr_text(tail);
    let detail = if stderr.is_empty() {
        "grok agent exited during startup".to_string()
    } else {
        format!("grok agent exited during startup: {stderr}")
    };
    DriverError::problem(startup_problem(Startup::Launch, &detail, &stderr))
}

/// The tool's name: Grok's own (`_meta["x.ai/tool"].name`, e.g. `read_file`), else the ACP kind
/// (when it says something), else the call's title.
fn tool_name(kind: &ToolKind, title: &str, meta: Option<&Meta>) -> String {
    if let Some(name) = meta
        .and_then(|meta| meta.get("x.ai/tool"))
        .and_then(|tool| tool.get("name"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
    {
        return name.to_string();
    }
    let kind = serde_json::to_value(kind).ok().and_then(|kind| kind.as_str().map(str::to_string));
    if let Some(kind) = kind.filter(|kind| kind != "other") {
        return kind;
    }
    let title = title.trim();
    if title.is_empty() { "other".into() } else { title.to_string() }
}

/// Grok runs every MCP tool through its `use_tool` built-in with `{tool_name: "<server>__<tool>",
/// tool_input}` (T3 Code, 3c9a54979a). Such a call is the MCP tool itself: `mcp__<server>__<tool>`,
/// with the tool's own arguments.
fn mcp_call(name: &str, raw_input: Option<&Value>) -> Option<(String, Value)> {
    if name != "use_tool" {
        return None;
    }
    let raw = raw_input?;
    let full = raw.get("tool_name").and_then(Value::as_str)?.trim();
    let (server, tool) = full.split_once("__").filter(|(server, tool)| !server.is_empty() && !tool.is_empty())?;
    let arguments = raw.get("tool_input").filter(|input| input.is_object()).cloned().unwrap_or_else(|| json!({}));
    Some((format!("mcp__{server}__{tool}"), arguments))
}

/// What a finished tool call reports. Grok wraps an MCP result as `{type: "MCP", output: {OkayOutput}
/// | {Error}}` (T3 Code); that becomes the MCP result shape other harnesses send, `{content: [{type:
/// "text", text}]}`, failed when it was an `Error`.
fn tool_output(status: Option<&str>, raw_output: Option<Value>, content: Value, title: Option<String>) -> (Value, bool) {
    let failed = status == Some("failed");
    let mcp = raw_output.as_ref().filter(|raw| raw.get("type").and_then(Value::as_str) == Some("MCP")).and_then(|raw| raw.get("output"));
    if let Some(output) = mcp {
        let (text, is_error) = match (output.get("OkayOutput").and_then(Value::as_str), output.get("Error").and_then(Value::as_str)) {
            (_, Some(error)) => (Some(error), true),
            (Some(okay), None) => (Some(okay), false),
            _ => (None, false),
        };
        if let Some(text) = text {
            let raw = json!({ "content": [{ "type": "text", "text": text }], "isError": is_error });
            return (json!({ "status": status, "raw": raw, "content": raw["content"], "title": title }), failed || is_error);
        }
    }
    (json!({ "status": status, "raw": raw_output, "content": content, "title": title }), failed)
}

/// A user message as ACP blocks. Text parts run together into one text block; an image is its own
/// image block (`grok` 1.0.92 advertises `promptCapabilities.image`, and T3 Code found Grok takes images
/// even where it says otherwise). A skill is Grok's own `/name` command, which Grok expands only at the
/// start of a prompt.
fn prompt_blocks(message: &UserMessage) -> Vec<ContentBlock> {
    acp::merge_text_blocks(acp::prompt_blocks(message))
}

/// One tick of `costUsdTicks` is 1e-10 USD.
const USD_PER_TICK: f64 = 1e-10;

/// A turn's tokens and cost from the prompt response's `_meta`. Grok's input already counts the
/// cached reads (as Codex's does), so `input_tokens` is taken as reported.
fn turn_usage(meta: Option<&Meta>) -> (Usage, Option<f64>) {
    let Some(meta) = meta else { return (Usage::default(), None) };
    let usage = meta.get("usage").and_then(Value::as_object);
    let tokens = |keys: &[&str]| usage.and_then(|usage| keys.iter().find_map(|key| usage.get(*key)).and_then(Value::as_u64)).unwrap_or(0);
    let ticks = usage
        .and_then(|usage| usage.get("costUsdTicks"))
        .or_else(|| meta.get("costUsdTicks"))
        .and_then(|ticks| ticks.as_f64().or_else(|| ticks.as_str().and_then(|ticks| ticks.parse().ok())));
    (
        Usage {
            input_tokens: tokens(&["inputTokens", "input_tokens", "promptTokens", "prompt_tokens"]),
            output_tokens: tokens(&["outputTokens", "output_tokens", "completionTokens", "completion_tokens"]),
            cache_read_tokens: tokens(&["cachedReadTokens", "cachedInputTokens", "cache_read_tokens", "cachedTokens", "cached_tokens"]),
            cache_write_tokens: tokens(&["cachedWriteTokens", "cacheWriteTokens", "cache_write_tokens"]),
        },
        ticks.map(|ticks| ticks * USD_PER_TICK),
    )
}

#[cfg(test)]
mod grok_meta_tests {
    use super::*;
    use crate::acp::{STDERR_TAIL_BYTES, fail_startup, prompt_with_guide, remember_stderr};
    use tokio::sync::oneshot;

    fn meta(value: Value) -> Meta {
        value.as_object().cloned().expect("an object")
    }

    #[test]
    fn tool_name_prefers_xai_meta_then_kind_then_title() {
        let named = meta(json!({ "x.ai/tool": { "name": "read_file" } }));
        assert_eq!(tool_name(&ToolKind::Other, "Read Cargo.toml", Some(&named)), "read_file");
        assert_eq!(tool_name(&ToolKind::Read, "Read Cargo.toml", Some(&named)), "read_file");
        // No usable name in the metadata: the ACP kind says what it is.
        let blank = meta(json!({ "x.ai/tool": { "name": " " } }));
        assert_eq!(tool_name(&ToolKind::Execute, "ls", Some(&blank)), "execute");
        assert_eq!(tool_name(&ToolKind::SwitchMode, "Plan", None), "switch_mode");
        // An `other` kind says nothing, so the title does.
        assert_eq!(tool_name(&ToolKind::Other, "  List crates ", None), "List crates");
        assert_eq!(tool_name(&ToolKind::Other, "", None), "other");
    }

    #[test]
    fn turn_usage_reads_meta_usage_and_cost() {
        let reported = meta(json!({
            "usage": { "inputTokens": 36893, "outputTokens": 267, "cachedReadTokens": 30000, "costUsdTicks": 155000000 }
        }));
        let (usage, cost) = turn_usage(Some(&reported));
        assert_eq!(
            usage,
            Usage { input_tokens: 36893, output_tokens: 267, cache_read_tokens: 30000, cache_write_tokens: 0 },
            "input is kept as reported: it already includes the cached reads"
        );
        assert!((cost.unwrap() - 0.0155).abs() < 1e-12, "{cost:?}");

        // The cost may sit beside the usage block.
        let beside = meta(json!({ "usage": { "inputTokens": 5, "outputTokens": 2 }, "costUsdTicks": 10_000_000_000u64 }));
        let (usage, cost) = turn_usage(Some(&beside));
        assert_eq!((usage.input_tokens, usage.output_tokens), (5, 2));
        assert!((cost.unwrap() - 1.0).abs() < 1e-9);

        // Nothing reported: zero tokens and no cost, not a made-up one.
        assert_eq!(turn_usage(None), (Usage::default(), None));
        assert_eq!(turn_usage(Some(&meta(json!({})))), (Usage::default(), None));
    }

    #[test]
    fn models_parse_with_markers_and_descriptions_and_skip_headings() {
        let models = parse_models(
            "Available models:\n\nMODEL  CONTEXT\n-----\ngrok-4  (default)  Flagship reasoning model\n* grok-code-fast-1\n  grok-build - Agentic coding\n# comment\n",
        );
        let ids: Vec<_> = models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["grok-4", "grok-code-fast-1", "grok-build"]);
        assert_eq!(models[0].description.as_deref(), Some("(default)  Flagship reasoning model"));
        assert!(models[0].is_default && models[1].is_default && models[2].is_default);
        assert_eq!(models[2].description.as_deref(), Some("Agentic coding"));
        assert!(parse_models("").is_empty());
    }

    #[test]
    fn the_guide_rides_on_the_first_ordinary_prompt_only() {
        let mut guide = Some("# Working in Kybern".to_string());
        // A slash command keeps the start of its prompt and leaves the guide for later.
        assert_eq!(prompt_with_guide(&mut guide, "/compact".into()), ("/compact".into(), None));
        assert!(guide.is_some());

        let (first, carried) = prompt_with_guide(&mut guide, "Hello".into());
        assert_eq!(carried.as_deref(), Some("# Working in Kybern"));
        assert!(first.starts_with("<kybern_instructions>\n# Working in Kybern\n</kybern_instructions>\n\n"), "{first}");
        assert!(first.ends_with("Hello"));
        assert_eq!(crate::cursor::without_guide(&first), "Hello");

        // Sent once: the next prompt is the user's own text.
        assert_eq!(prompt_with_guide(&mut guide, "Again".into()), ("Again".into(), None));
    }

    #[test]
    fn a_failed_start_reaches_the_caller_and_stderr_explains_an_early_exit() {
        let (tx, mut rx) = oneshot::channel::<Result<String>>();
        let mut bound = Some(tx);
        let _ = fail_startup(&mut bound, startup_problem(Startup::NewSession, "session/new: Internal error: boom", ""));
        assert!(bound.is_none());
        let Ok(Err(error)) = rx.try_recv() else { panic!("expected the startup error") };
        assert_eq!(error.to_string(), "session/new: Internal error: boom", "the error's text is the technical detail");
        let problem = crate::failure::classify_error(ProviderKind::GrokBuild, &error).expect("a worded problem");
        assert_eq!(problem.title.as_deref(), Some("Grok Build couldn't start a conversation"));

        let tail = std::sync::Mutex::new(String::new());
        assert_eq!(startup_exit_error(&tail).to_string(), "grok agent exited during startup");
        for line in 0..100 {
            remember_stderr(&tail, &format!("error line {line}"));
        }
        let message = startup_exit_error(&tail).to_string();
        assert!(message.contains("error line 99") && !message.contains("error line 0\n"), "{message}");
        assert!(tail.lock().unwrap().len() <= STDERR_TAIL_BYTES);
    }
}

#[cfg(test)]
#[path = "grok_tests.rs"]
mod grok_tests;
