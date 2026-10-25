//! The other summoned-card tools: `kybern_ask_user` (a question that can
//! answer itself after a deadline), `kybern_request_permission` (a macOS
//! privacy permission) and `kybern_run_in_terminal` (a command the user can
//! answer prompts for). Sign-in is in `login_request.rs`; the password card in
//! `askpass.rs`.
//!
//! All of them are daemon-owned approval cards (`open_daemon_card`) that wait
//! on the card's decision and, where the card has steps, on `requests.act`.
//! A deadline applies to questions only: never to approvals, passwords,
//! secrets, sign-ins or permissions.

use kybern_protocol::process::NoWindow;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Result, anyhow, bail};
use chrono::Utc;
use kybern_protocol::*;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::time::Instant;
use uuid::Uuid;

use super::{LiveSession, Orchestrator};
use crate::requests::RequestAct;

pub(crate) const ASK_TOOL: &str = "kybern_ask_user";
pub(crate) const PERMISSION_TOOL: &str = PERMISSION_REQUEST_TOOL;
pub(crate) const TERMINAL_TOOL: &str = "kybern_run_in_terminal";
/// A question without a deadline waits this long, then the call returns `timed_out`.
const QUESTION_WAIT: Duration = Duration::from_secs(60 * 60);
const MIN_DEADLINE_SECONDS: u64 = 30;
const PERMISSION_WAIT: Duration = Duration::from_secs(30 * 60);
const TERMINAL_DEFAULT_SECONDS: u64 = 600;
const TERMINAL_MAX_SECONDS: u64 = 1800;
const TERMINAL_TAIL_LINES: usize = 80;
const TERMINAL_LINE_CHARS: usize = 300;
const DONE_HOLD: Duration = Duration::from_millis(900);

pub(crate) fn is_tool(name: &str) -> bool {
    matches!(name, ASK_TOOL | PERMISSION_TOOL | TERMINAL_TOOL)
}

/// How long a call to `name` may run, when longer than an ordinary tool call.
pub(crate) fn call_budget(name: &str, arguments: &Value) -> Option<Duration> {
    match name {
        ASK_TOOL => {
            let deadline = arguments.get("deadline_seconds").and_then(Value::as_u64).unwrap_or(0).min(14_400);
            Some(QUESTION_WAIT + Duration::from_secs(deadline + 60))
        }
        PERMISSION_TOOL => Some(PERMISSION_WAIT + Duration::from_secs(60)),
        TERMINAL_TOOL => {
            let wait =
                arguments.get("timeout_seconds").and_then(Value::as_u64).unwrap_or(TERMINAL_DEFAULT_SECONDS).min(TERMINAL_MAX_SECONDS);
            // The permission card may come first.
            Some(Duration::from_secs(wait) + Duration::from_secs(10 * 60 + 60))
        }
        _ => None,
    }
}

pub(crate) fn tool_definitions() -> Vec<kybern_drivers::NativeToolDefinition> {
    let mut tools = vec![
        kybern_drivers::NativeToolDefinition {
            name: ASK_TOOL.into(),
            description: concat!(
                "Ask the user one to four questions with choices, and wait for the answers. Use it instead of a plain chat question when you can ",
                "keep working with a sensible default: give each question a default (one of its option labels) and set deadline_seconds, and Kybern ",
                "picks your defaults for the user once that long has passed with no answer (capped by the user's own limit; the user sees a countdown and ",
                "can wait, pick or change the answer later). Never use a deadline for anything risky or irreversible. Without deadline_seconds the ",
                "question waits up to an hour. status is \"answered\", \"auto_answered\" (the deadline passed, so the answers are your defaults), ",
                "\"declined\" (the user chose not to answer: continue without asking again), \"cancelled\" (the run ended) or \"timed_out\". ",
                "Result: {status, answers: {question: label, or [labels] for multi_select}, attachments?: {question: [{kind, path}]}, waited_seconds?}; ",
                "the user may attach images or files to an answer. The question is Markdown. An option's preview is text or a fenced code block shown ",
                "while the option is focused; for anything richer, publish a visual with await_answer instead. Not for passwords, secrets, sign-ins or ",
                "permissions: those have their own tools and never auto-answer."
            )
            .into(),
            input_schema: json!({
                "type": "object", "additionalProperties": false,
                "properties": {
                    "questions": {"type":"array","minItems":1,"maxItems":4,"items":{
                        "type":"object","additionalProperties":false,
                        "properties":{
                            "question":{"type":"string","minLength":1,"maxLength":1000,"description":"Markdown."},
                            "header":{"type":["string","null"],"maxLength":12,"description":"A very short label for the question, e.g. \"Layout\"."},
                            "options":{"type":"array","minItems":2,"maxItems":6,"items":{
                                "type":"object","additionalProperties":false,
                                "properties":{"label":{"type":"string","minLength":1,"maxLength":80},"description":{"type":["string","null"],"maxLength":300},"preview":{"type":["string","null"],"maxLength":MAX_OPTION_PREVIEW_BYTES,"description":"Text or a fenced code block to show while this option is focused."}},
                                "required":["label"]}},
                            "multi_select":{"type":["boolean","null"],"description":"Allow several options. Not with a default."},
                            "default":{"type":["string","null"],"description":"The label to pick when the deadline passes. Required for every question when deadline_seconds is set."}
                        },
                        "required":["question","options"]}},
                    "deadline_seconds": {"type":["integer","null"],"minimum":MIN_DEADLINE_SECONDS,"maximum":14400,"description":"Pick the defaults after this many seconds without an answer. The user's own limit caps it."}
                },
                "required": ["questions"]
            }),
        },
        kybern_drivers::NativeToolDefinition {
            name: TERMINAL_TOOL.into(),
            description: concat!(
                "Run a command in a terminal tab the user can see and type into, and wait for it to finish. Use it for a command that needs the user at the ",
                "keyboard (an interactive prompt, a login, a confirmation) and that you cannot run with non-interactive flags such as -y or --yes. ",
                "reason says why, in a sentence. In any mode but Full access the user approves the command first. The tool returns when the command ",
                "exits or timeout_seconds passes (default 600, at most 1800). Result: {status: \"exited\"|\"running\", exit_code?, output} where output is the ",
                "last 80 lines (bounded). A command that keeps running stays in its tab: read it with kybern_read_terminal."
            )
            .into(),
            input_schema: json!({
                "type": "object", "additionalProperties": false,
                "properties": {
                    "command": {"type":"string","minLength":1,"maxLength":2000,"description":"The shell command to run, in the workspace folder."},
                    "reason": {"type":"string","minLength":1,"maxLength":300,"description":"Why it needs the user, in a sentence."},
                    "timeout_seconds": {"type":["integer","null"],"minimum":10,"maximum":TERMINAL_MAX_SECONDS,"description":"How long to wait for it to exit. Default 600."}
                },
                "required": ["command", "reason"]
            }),
        },
    ];
    {
        tools.push(kybern_drivers::NativeToolDefinition {
            name: PERMISSION_TOOL.into(),
            description: concat!(
                "Ask the user to turn on a macOS privacy permission for an app (for example the app you are building needs the camera) and wait. ",
                "pane is one of camera, microphone, screen_recording, accessibility, local_network, full_disk_access, notifications, location. ",
                "app is the app's name (or bundle_id its identifier); reason says why, in a sentence. The user gets a card that opens the exact System ",
                "Settings pane; Kybern watches for the grant where macOS lets it and otherwise asks the user to confirm. Screen Recording, Accessibility ",
                "and Full Disk Access need the app relaunched afterwards (relaunch: true). status is \"granted\", \"user_confirmed\" (the user says it is on), ",
                "\"stopped\", \"declined\", \"cancelled\" or \"timed_out\". Result: {status, pane, app, relaunch}."
            )
            .into(),
            input_schema: json!({
                "type": "object", "additionalProperties": false,
                "properties": {
                    "pane": {"enum": PANES.iter().map(|pane| pane.name).collect::<Vec<_>>()},
                    "app": {"type":"string","minLength":1,"maxLength":120,"description":"The app that needs the permission, e.g. Anamorphia."},
                    "bundle_id": {"type":["string","null"],"maxLength":160,"description":"The app's bundle identifier, if you know it."},
                    "reason": {"type":"string","minLength":1,"maxLength":300}
                },
                "required": ["pane", "app", "reason"]
            }),
        });
    }
    tools
}

// ---- permission panes ----

pub(crate) struct Pane {
    pub name: &'static str,
    /// What the card's title says the app may do: "Let X <verb>".
    pub label: &'static str,
    /// `x-apple.systempreferences:` link.
    pub url: &'static str,
    /// The `service` column of TCC.db, when macOS keeps the grant there.
    pub tcc: Option<&'static str>,
    pub needs_app_added: bool,
    pub relaunch: bool,
}

pub(crate) const PANES: &[Pane] = &[
    Pane {
        name: "camera",
        label: "Privacy & Security › Camera",
        url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera",
        tcc: Some("kTCCServiceCamera"),
        needs_app_added: false,
        relaunch: false,
    },
    Pane {
        name: "microphone",
        label: "Privacy & Security › Microphone",
        url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
        tcc: Some("kTCCServiceMicrophone"),
        needs_app_added: false,
        relaunch: false,
    },
    Pane {
        name: "screen_recording",
        label: "Privacy & Security › Screen & System Audio Recording",
        url: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
        tcc: Some("kTCCServiceScreenCapture"),
        needs_app_added: false,
        relaunch: true,
    },
    Pane {
        name: "accessibility",
        label: "Privacy & Security › Accessibility",
        url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
        tcc: Some("kTCCServiceAccessibility"),
        needs_app_added: true,
        relaunch: true,
    },
    Pane {
        name: "local_network",
        label: "Privacy & Security › Local Network",
        url: "x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork",
        tcc: None,
        needs_app_added: false,
        relaunch: false,
    },
    Pane {
        name: "full_disk_access",
        label: "Privacy & Security › Full Disk Access",
        url: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
        tcc: Some("kTCCServiceSystemPolicyAllFiles"),
        needs_app_added: true,
        relaunch: true,
    },
    Pane {
        name: "notifications",
        label: "Notifications",
        url: "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
        tcc: None,
        needs_app_added: false,
        relaunch: false,
    },
    Pane {
        name: "location",
        label: "Privacy & Security › Location Services",
        url: "x-apple.systempreferences:com.apple.preference.security?Privacy_LocationServices",
        tcc: None,
        needs_app_added: false,
        relaunch: false,
    },
];

pub(crate) fn pane(name: &str) -> Option<&'static Pane> {
    PANES.iter().find(|pane| pane.name == name)
}

/// A name safe to put inside an AppleScript string.
fn plain_app_name(name: &str) -> bool {
    !name.is_empty() && !name.chars().any(|c| c.is_control() || matches!(c, '"' | '\\'))
}

/// The app's bundle id and location, when LaunchServices knows the app. Best effort.
async fn locate_app(name: &str) -> (Option<String>, Option<String>) {
    if !plain_app_name(name) {
        return (None, None);
    }
    let ask = |script: String| async move {
        let mut command = tokio::process::Command::new("osascript").no_window();
        command.args(["-e", &script]).stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null()).kill_on_drop(true);
        let output = tokio::time::timeout(Duration::from_secs(5), command.output()).await.ok()?.ok()?;
        output.status.success().then(|| String::from_utf8_lossy(&output.stdout).trim().to_string()).filter(|text| !text.is_empty())
    };
    let id = ask(format!("id of app \"{name}\"")).await;
    let path = ask(format!("POSIX path of (path to application \"{name}\")")).await;
    (id, path)
}

fn tcc_databases() -> Vec<std::path::PathBuf> {
    let mut dbs = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        dbs.push(std::path::PathBuf::from(home).join("Library/Application Support/com.apple.TCC/TCC.db"));
    }
    dbs.push("/Library/Application Support/com.apple.TCC/TCC.db".into());
    dbs
}

async fn tcc_query(db: &std::path::Path, sql: String) -> Option<String> {
    let mut command = tokio::process::Command::new("sqlite3").no_window();
    command.arg("-readonly").arg(db).arg(sql).stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null()).kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(4), command.output()).await.ok()?.ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Whether macOS has the permission on for this app. `None` when Kybern is
/// not allowed to read the privacy database (it needs Full Disk Access), in
/// which case the user confirms the grant themselves.
pub(crate) async fn tcc_granted(service: &str, bundle_id: &str) -> Option<bool> {
    if !bundle_id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')) || bundle_id.is_empty() {
        return None;
    }
    let mut readable = false;
    for db in tcc_databases() {
        let sql = format!(
            "select auth_value from access where service='{service}' and client='{bundle_id}' order by last_modified desc limit 1;"
        );
        if let Some(value) = tcc_query(&db, sql).await {
            readable = true;
            if value == "2" {
                return Some(true);
            }
        }
    }
    readable.then_some(false)
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PermissionArguments {
    pane: String,
    app: String,
    #[serde(default)]
    bundle_id: Option<String>,
    reason: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TerminalArguments {
    command: String,
    reason: String,
    #[serde(default)]
    timeout_seconds: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AskArguments {
    questions: Vec<AskQuestion>,
    #[serde(default)]
    deadline_seconds: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AskQuestion {
    question: String,
    #[serde(default)]
    header: Option<String>,
    options: Vec<AskOption>,
    #[serde(default)]
    multi_select: Option<bool>,
    #[serde(default)]
    default: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AskOption {
    label: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    preview: Option<String>,
}

/// A validated `kybern_ask_user` call: the card's questions and, when the
/// agent asked for one, each question's default.
#[derive(Debug, PartialEq)]
pub(crate) struct Ask {
    pub questions: Vec<Value>,
    pub defaults: std::collections::BTreeMap<String, String>,
    pub deadline_seconds: Option<u64>,
}

pub(crate) fn parse_ask(arguments: Value) -> Result<Ask> {
    let raw: AskArguments = serde_json::from_value(arguments)
        .map_err(|error| anyhow!("Invalid arguments for kybern_ask_user: {error}. Pass questions (each with question and options), and optionally default and deadline_seconds."))?;
    if raw.questions.is_empty() || raw.questions.len() > 4 {
        bail!("Ask one to four questions.");
    }
    let mut questions = Vec::new();
    let mut defaults = std::collections::BTreeMap::new();
    for (index, question) in raw.questions.iter().enumerate() {
        let text = question.question.trim();
        if text.is_empty() || text.chars().count() > 1000 {
            bail!("Each question must be 1 to 1000 characters.");
        }
        if question.options.iter().any(|option| option.preview.as_ref().is_some_and(|preview| preview.len() > MAX_OPTION_PREVIEW_BYTES)) {
            bail!(
                "Option previews must be at most {} KB. Shorten them, or publish a visual with await_answer.",
                MAX_OPTION_PREVIEW_BYTES / 1024
            );
        }
        if question.options.len() < 2 || question.options.len() > 6 {
            bail!("Question {} needs two to six options.", index + 1);
        }
        let labels: Vec<&str> = question.options.iter().map(|option| option.label.trim()).collect();
        if labels.iter().any(|label| label.is_empty()) || (1..labels.len()).any(|i| labels[..i].contains(&labels[i])) {
            bail!("Question {} needs distinct, non-empty option labels.", index + 1);
        }
        let multi = question.multi_select.unwrap_or(false);
        if let Some(default) = question.default.as_deref().map(str::trim).filter(|default| !default.is_empty()) {
            if multi {
                bail!("Question {} allows several answers, so it can't have a default.", index + 1);
            }
            if !labels.contains(&default) {
                bail!("The default for question {} must be one of its option labels.", index + 1);
            }
            defaults.insert(text.to_string(), default.to_string());
        }
        let header: String =
            question.header.as_deref().map(str::trim).filter(|h| !h.is_empty()).unwrap_or("Question").chars().take(12).collect();
        questions.push(json!({
            "question": text,
            "header": header,
            "multiSelect": multi,
            "options": question.options.iter().map(|option| {
                let mut item = json!({
                    "label": option.label.trim(),
                    "description": option.description.as_deref().map(str::trim).unwrap_or(""),
                });
                if let Some(preview) = option.preview.as_deref().filter(|preview| !preview.trim().is_empty()) {
                    item["preview"] = json!(preview);
                }
                item
            }).collect::<Vec<_>>(),
        }));
    }
    if let Some(seconds) = raw.deadline_seconds {
        if seconds < MIN_DEADLINE_SECONDS {
            bail!("deadline_seconds must be at least {MIN_DEADLINE_SECONDS}.");
        }
        if defaults.len() != raw.questions.len() {
            bail!(
                "A deadline needs a default for every question, so Kybern knows what to pick. Add default to each question, or drop deadline_seconds."
            );
        }
    }
    Ok(Ask { questions, defaults, deadline_seconds: raw.deadline_seconds })
}

/// Last lines of terminal output as plain text.
fn tail_lines(bytes: &[u8]) -> String {
    let text = kybern_drivers::account_auth::strip_ansi(&String::from_utf8_lossy(bytes)).replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<&str> = text.lines().map(str::trim_end).collect();
    let start = lines.len().saturating_sub(TERMINAL_TAIL_LINES);
    lines[start..]
        .iter()
        .map(|line| {
            if line.chars().count() > TERMINAL_LINE_CHARS {
                line.chars().take(TERMINAL_LINE_CHARS).collect::<String>() + "…"
            } else {
                (*line).to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim_matches('\n')
        .to_string()
}

fn base_progress(thread_id: ThreadId, approval_id: ApprovalId, kind: RequestKind, phase: RequestPhase) -> RequestProgress {
    RequestProgress {
        approval_id,
        thread_id,
        kind,
        phase,
        method: None,
        url: None,
        user_code: None,
        terminal: None,
        account: None,
        error: None,
        ends_at: None,
        remaining_ms: None,
        updated_at: Utc::now(),
    }
}

struct HubGuard {
    hub: crate::requests::RequestHub,
    card: ApprovalId,
}

impl Drop for HubGuard {
    fn drop(&mut self) {
        self.hub.remove(self.card);
    }
}

/// Wait for a card's decision. `None` when the card went away without one.
/// The channel guard is dropped here so callers can keep awaiting.
pub(super) async fn wait_decision(receiver: &mut tokio::sync::watch::Receiver<Option<ApprovalDecision>>) -> Option<ApprovalDecision> {
    match receiver.wait_for(Option::is_some).await {
        Ok(decision) => decision.clone(),
        Err(_) => None,
    }
}

fn deny_status(decision: &Option<ApprovalDecision>) -> &'static str {
    match decision {
        Some(ApprovalDecision::Deny { reason }) if reason.as_deref() == Some("turn ended") => "cancelled",
        Some(ApprovalDecision::Deny { reason }) if reason.as_deref() == Some("timed out") => "timed_out",
        Some(ApprovalDecision::Deny { .. }) => "declined",
        _ => "cancelled",
    }
}

impl Orchestrator {
    pub(super) async fn execute_request_tool(
        &self,
        thread: &Thread,
        turn_id: TurnId,
        live: &Arc<LiveSession>,
        name: &str,
        arguments: Value,
    ) -> Result<Value> {
        let (this, live, thread) = (self.clone(), live.clone(), thread.clone());
        let name = name.to_owned();
        // Each runs in its own task: a harness that gives up on the call first
        // still leaves the card to finish cleanly.
        tokio::spawn(async move {
            match name.as_str() {
                ASK_TOOL => this.run_ask_user(&thread, turn_id, live, arguments).await,
                PERMISSION_TOOL => this.run_permission_request(&thread, turn_id, live, arguments).await,
                TERMINAL_TOOL => this.run_in_terminal(&thread, turn_id, live, arguments).await,
                _ => Err(anyhow!("unknown request tool")),
            }
        })
        .await
        .map_err(|_| anyhow!("The request failed. Call the tool again."))?
    }

    // ---- kybern_ask_user ----

    async fn run_ask_user(&self, thread: &Thread, turn_id: TurnId, live: Arc<LiveSession>, arguments: Value) -> Result<Value> {
        let ask = parse_ask(arguments)?;
        let settings = self.inner.settings.get().ask_deadlines;
        let cap = settings.max_seconds.clamp(60, 14_400);
        // Off in Settings, or no deadline asked: the question simply waits.
        let seconds = ask.deadline_seconds.filter(|_| settings.enabled).map(|seconds| seconds.min(cap));
        let started = Utc::now();
        let mut ends_at = seconds.map(|seconds| started + chrono::Duration::seconds(seconds as i64));
        let mut input = json!({ "questions": ask.questions });
        if let (Some(seconds), Some(ends)) = (seconds, ends_at) {
            input["deadline"] =
                serde_json::to_value(QuestionDeadline { defaults: ask.defaults.clone(), seconds, started_at: started, ends_at: ends })?;
        }
        let summary = ask.questions.first().and_then(|q| q["question"].as_str()).unwrap_or("Question").to_string();
        let key = format!("ask:{}", Uuid::now_v7());
        let (card, mut decision) = self.open_daemon_card(thread.id, turn_id, &live, key, "AskUserQuestion", input, summary, None).await?;
        let hub = self.requests().clone();
        let mut progress = base_progress(thread.id, card, RequestKind::Question, RequestPhase::Asking);
        progress.ends_at = ends_at;
        let mut acts = hub.register(progress);
        let _guard = HubGuard { hub: hub.clone(), card };
        // Time left when paused; `None` while it runs.
        let mut paused_with: Option<Duration> = None;
        let mut held = seconds.is_none();
        let hard_stop = Instant::now() + QUESTION_WAIT + Duration::from_secs(cap);
        loop {
            let fires = match (ends_at, paused_with, held) {
                (Some(at), None, false) => Some(Instant::now() + (at - Utc::now()).to_std().unwrap_or(Duration::ZERO)),
                _ => None,
            };
            tokio::select! {
                decided = wait_decision(&mut decision) => {
                    return Ok(match &decided {
                        Some(ApprovalDecision::Submit { response }) => {
                            let mut result = json!({ "status": "answered", "answers": response.get("answers").cloned().unwrap_or(json!({})) });
                            if let Some(attachments) = response.get("attachments").filter(|attachments| attachments.is_object()) {
                                result["attachments"] = attachments.clone();
                            }
                            result
                        }
                        other => json!({ "status": deny_status(other) }),
                    });
                }
                act = acts.recv() => {
                    let Some(act) = act else { return Ok(json!({ "status": "cancelled" })) };
                    match act.action.as_str() {
                        "pause" if !held && paused_with.is_none() => {
                            let left = ends_at.map(|at| (at - Utc::now()).to_std().unwrap_or(Duration::ZERO)).unwrap_or_default();
                            paused_with = Some(left);
                            hub.update(card, |p| { p.phase = RequestPhase::Paused; p.remaining_ms = Some(left.as_millis() as u64); p.ends_at = None; });
                        }
                        "resume" if !held => {
                            if let Some(left) = paused_with.take() {
                                let at = Utc::now() + chrono::Duration::from_std(left)?;
                                ends_at = Some(at);
                                hub.update(card, |p| { p.phase = RequestPhase::Asking; p.remaining_ms = None; p.ends_at = Some(at); });
                            }
                        }
                        "hold" => {
                            held = true;
                            paused_with = None;
                            ends_at = None;
                            hub.update(card, |p| { p.phase = RequestPhase::Held; p.remaining_ms = None; p.ends_at = None; });
                        }
                        _ => {}
                    }
                }
                _ = async { match fires { Some(at) => tokio::time::sleep_until(at).await, None => std::future::pending().await } } => {
                    let waited = seconds.unwrap_or(0);
                    let auto = json!({ "at": Utc::now(), "waited_seconds": waited });
                    let answers = json!(ask.defaults);
                    let response = json!({ "answers": answers, "auto": auto });
                    let ours = self.finish_daemon_card(thread.id, turn_id, &live, card, ApprovalDecision::Submit { response }).await?;
                    if ours {
                        return Ok(json!({ "status": "auto_answered", "answers": answers, "waited_seconds": waited }));
                    }
                    // The user answered in the same instant: the decision branch returns it.
                    ends_at = None;
                    held = true;
                }
                _ = tokio::time::sleep_until(hard_stop) => {
                    self.finish_daemon_card(thread.id, turn_id, &live, card, ApprovalDecision::Deny { reason: Some("timed out".into()) }).await?;
                    return Ok(json!({ "status": "timed_out" }));
                }
            }
        }
    }

    // ---- kybern_request_permission ----

    async fn run_permission_request(&self, thread: &Thread, turn_id: TurnId, live: Arc<LiveSession>, arguments: Value) -> Result<Value> {
        if !cfg!(target_os = "macos") {
            bail!("kybern_request_permission only works on a Mac.");
        }
        let raw: PermissionArguments = serde_json::from_value(arguments)
            .map_err(|error| anyhow!("Invalid arguments for kybern_request_permission: {error}. Pass pane, app and reason."))?;
        let pane = pane(&raw.pane)
            .ok_or_else(|| anyhow!("pane must be one of {}.", PANES.iter().map(|p| p.name).collect::<Vec<_>>().join(", ")))?;
        let app = raw.app.trim().to_owned();
        let reason = raw.reason.trim().to_owned();
        if app.is_empty() || app.chars().count() > 120 || reason.is_empty() || reason.chars().count() > 300 {
            bail!("app must be 1 to 120 characters and reason 1 to 300.");
        }
        let (found_id, app_path) = locate_app(&app).await;
        let bundle_id = raw.bundle_id.map(|id| id.trim().to_owned()).filter(|id| !id.is_empty()).or(found_id);
        let detects = match (pane.tcc, bundle_id.as_deref()) {
            (Some(service), Some(bundle)) => tcc_granted(service, bundle).await.is_some(),
            _ => false,
        };
        let mut url = pane.url.to_string();
        if pane.name == "notifications"
            && let Some(bundle) = &bundle_id
        {
            url = format!("{url}?id={bundle}");
        }
        let input = PermissionRequestInput {
            pane: pane.name.into(),
            app: app.clone(),
            bundle_id: bundle_id.clone(),
            app_path: app_path.clone(),
            reason,
            pane_label: pane.label.into(),
            url: url.clone(),
            needs_app_added: pane.needs_app_added,
            relaunch: pane.relaunch,
            detects,
        };
        let key = format!("permission:{}", Uuid::now_v7());
        let (card, mut decision) = self
            .open_daemon_card(
                thread.id,
                turn_id,
                &live,
                key,
                PERMISSION_TOOL,
                serde_json::to_value(&input)?,
                format!("Turn on {} for {app}", pane.name),
                None,
            )
            .await?;
        let hub = self.requests().clone();
        let mut progress = base_progress(thread.id, card, RequestKind::Permission, RequestPhase::Asking);
        progress.url = Some(url);
        let mut acts = hub.register(progress);
        let _guard = HubGuard { hub: hub.clone(), card };
        let result = |status: &str| json!({ "status": status, "pane": pane.name, "app": app, "relaunch": pane.relaunch });
        let granted_now = || async {
            match (pane.tcc, bundle_id.as_deref()) {
                (Some(service), Some(bundle)) if detects => tcc_granted(service, bundle).await,
                _ => None,
            }
        };
        let mut poll = tokio::time::interval(Duration::from_secs(2));
        poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut waiting_since: Option<Instant> = None;
        let hard_stop = Instant::now() + PERMISSION_WAIT;
        let done = |status: &'static str| {
            let hub = hub.clone();
            async move {
                hub.set_phase(card, RequestPhase::Done);
                tokio::time::sleep(DONE_HOLD).await;
                status
            }
        };
        loop {
            tokio::select! {
                decided = wait_decision(&mut decision) => {
                    return Ok(result(deny_status(&decided)));
                }
                act = acts.recv() => {
                    let Some(RequestAct { action, .. }) = act else { return Ok(result("cancelled")) };
                    match action.as_str() {
                        "open" => {
                            waiting_since = Some(Instant::now());
                            hub.update(card, |p| { p.phase = RequestPhase::Waiting; p.error = None; });
                            if pane.needs_app_added && let Some(path) = &app_path {
                                // Show the app in Finder so it can be dragged into the list.
                                let _ = tokio::process::Command::new("open").no_window().arg("-R").arg(path).status().await;
                            }
                        }
                        "check" | "granted" => {
                            let confirmed_by_user = action == "granted";
                            match granted_now().await {
                                Some(true) => {
                                    let status = done("granted").await;
                                    let ours = self.finish_daemon_card(thread.id, turn_id, &live, card, ApprovalDecision::Submit { response: result(status) }).await?;
                                    if ours { return Ok(result(status)); }
                                }
                                Some(false) => {
                                    waiting_since = Some(Instant::now());
                                    hub.update(card, |p| { p.phase = RequestPhase::NotGranted; p.error = Some(format!("{app} is still off. Turn it on in System Settings, then check again.")); });
                                }
                                None if confirmed_by_user => {
                                    let status = done("user_confirmed").await;
                                    let ours = self.finish_daemon_card(thread.id, turn_id, &live, card, ApprovalDecision::Submit { response: result(status) }).await?;
                                    if ours { return Ok(result(status)); }
                                }
                                None => {
                                    hub.update(card, |p| { p.phase = RequestPhase::Waiting; p.error = None; });
                                }
                            }
                        }
                        "stop" => {
                            self.finish_daemon_card(thread.id, turn_id, &live, card, ApprovalDecision::Submit { response: result("stopped") }).await?;
                            return Ok(result("stopped"));
                        }
                        _ => {}
                    }
                }
                _ = poll.tick(), if waiting_since.is_some() && detects => {
                    match granted_now().await {
                        Some(true) => {
                            let status = done("granted").await;
                            let ours = self.finish_daemon_card(thread.id, turn_id, &live, card, ApprovalDecision::Submit { response: result(status) }).await?;
                            if ours { return Ok(result(status)); }
                        }
                        _ => {
                            // Two minutes without the grant: say so, and keep watching.
                            if waiting_since.is_some_and(|since| since.elapsed() > Duration::from_secs(120))
                                && hub.get(card).is_some_and(|p| p.phase == RequestPhase::Waiting)
                            {
                                hub.update(card, |p| { p.phase = RequestPhase::NotGranted; p.error = Some(format!("{app} is still off. Turn it on in System Settings.")); });
                            }
                        }
                    }
                }
                _ = tokio::time::sleep_until(hard_stop) => {
                    self.finish_daemon_card(thread.id, turn_id, &live, card, ApprovalDecision::Deny { reason: Some("timed out".into()) }).await?;
                    return Ok(result("timed_out"));
                }
            }
        }
    }

    // ---- kybern_run_in_terminal ----

    async fn run_in_terminal(&self, thread: &Thread, turn_id: TurnId, live: Arc<LiveSession>, arguments: Value) -> Result<Value> {
        let raw: TerminalArguments = serde_json::from_value(arguments)
            .map_err(|error| anyhow!("Invalid arguments for kybern_run_in_terminal: {error}. Pass command and reason."))?;
        let command = raw.command.trim().to_owned();
        let reason = raw.reason.trim().to_owned();
        if command.is_empty() || command.len() > 2000 || command.contains('\0') || reason.is_empty() || reason.chars().count() > 300 {
            bail!("command must be 1 to 2000 characters and reason 1 to 300.");
        }
        let wait = Duration::from_secs(raw.timeout_seconds.unwrap_or(TERMINAL_DEFAULT_SECONDS).clamp(10, TERMINAL_MAX_SECONDS));
        // The agent chooses the command, so any mode that would ask before
        // running a shell command asks here too, with the usual command card.
        if thread.permission_mode != PermissionMode::FullAccess {
            let input = json!({ "command": command, "description": reason });
            let key = format!("terminal:{}", Uuid::now_v7());
            let (card, mut decision) =
                self.open_daemon_card(thread.id, turn_id, &live, key, "Bash", input, format!("Run in a terminal: {command}"), None).await?;
            let decided = tokio::time::timeout(Duration::from_secs(10 * 60), wait_decision(&mut decision)).await;
            match decided {
                Ok(Some(ApprovalDecision::AllowOnce | ApprovalDecision::AllowAlways)) => {}
                Ok(Some(ApprovalDecision::Deny { reason })) if reason.as_deref() == Some("turn ended") => {
                    return Ok(json!({ "status": "cancelled" }));
                }
                Ok(Some(_)) => return Ok(json!({ "status": "declined" })),
                Ok(None) => return Ok(json!({ "status": "cancelled" })),
                Err(_) => {
                    self.finish_daemon_card(thread.id, turn_id, &live, card, ApprovalDecision::Deny { reason: Some("timed out".into()) })
                        .await?;
                    return Ok(json!({ "status": "timed_out" }));
                }
            }
        }
        let terminals = self.inner.app_tools.terminal_manager().clone();
        let cwd = std::path::PathBuf::from(&thread.cwd);
        let env = std::collections::BTreeMap::new();
        let terminal = terminals.create_with_env(
            None,
            Some(thread.id),
            cwd.to_string_lossy().into_owned(),
            100,
            30,
            Some(vec![crate::cli_login::shell(), "-lc".into(), command.clone()]),
            &env,
        )?;
        let hub = self.requests().clone();
        let run_id = terminal.info().id;
        let mut progress = base_progress(thread.id, run_id, RequestKind::Terminal, RequestPhase::Waiting);
        progress.terminal = Some(terminal.info());
        hub.register(progress);
        let _guard = HubGuard { hub: hub.clone(), card: run_id };
        let deadline = Instant::now() + wait;
        let exited = loop {
            if !terminal.info().alive {
                break true;
            }
            // The turn ending (a stop) must not leave the call waiting.
            if live.turn.lock().await.as_ref().is_none_or(|active| active.id != turn_id) {
                return Ok(json!({ "status": "cancelled", "terminal_id": run_id }));
            }
            if Instant::now() >= deadline {
                break false;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        };
        let (_, bytes) = terminal.subscribe_output(true);
        let output = tail_lines(&bytes);
        let info = terminal.info();
        hub.set_phase(run_id, RequestPhase::Done);
        Ok(if exited {
            json!({ "status": "exited", "exit_code": info.exit_code, "terminal_id": run_id, "output": output })
        } else {
            json!({ "status": "running", "terminal_id": run_id, "output": output })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn question(extra: Value) -> Value {
        let mut base = json!({"question":"Which layout?","options":[{"label":"A"},{"label":"B"}]});
        base.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        base
    }

    #[test]
    fn a_deadline_needs_a_default_for_every_question() {
        let ok = parse_ask(json!({"questions":[question(json!({"default":"B"}))],"deadline_seconds":120})).unwrap();
        assert_eq!(ok.defaults.get("Which layout?").map(String::as_str), Some("B"));
        assert_eq!(ok.deadline_seconds, Some(120));
        let missing = parse_ask(json!({"questions":[question(json!({}))],"deadline_seconds":120})).unwrap_err().to_string();
        assert!(missing.contains("default for every question"), "{missing}");
        assert!(parse_ask(json!({"questions":[question(json!({"default":"C"}))]})).is_err(), "a default must be an option");
        assert!(parse_ask(json!({"questions":[question(json!({"default":"A","multi_select":true}))]})).is_err());
        assert!(parse_ask(json!({"questions":[question(json!({"default":"A"}))],"deadline_seconds":5})).is_err());
        let plain = parse_ask(json!({"questions":[question(json!({}))]})).unwrap();
        assert!(plain.defaults.is_empty() && plain.deadline_seconds.is_none());
        assert_eq!(plain.questions[0]["header"], "Question");
    }

    #[test]
    fn terminal_output_is_bounded_plain_text() {
        let long: String = (0..200).map(|i| format!("line {i}\r\n")).collect();
        let tail = tail_lines(long.as_bytes());
        assert_eq!(tail.lines().count(), TERMINAL_TAIL_LINES);
        assert!(tail.ends_with("line 199"));
        assert_eq!(tail_lines("\u{1b}[31mred\u{1b}[0m\r\nok\r\n".as_bytes()), "red\nok");
    }

    #[test]
    fn every_pane_has_a_system_settings_link() {
        for pane in PANES {
            assert!(pane.url.starts_with("x-apple.systempreferences:"), "{}", pane.name);
        }
        assert!(pane("camera").is_some() && pane("nope").is_none());
        assert!(plain_app_name("Anamorphia") && !plain_app_name("a\"b"));
    }

    #[test]
    fn budgets_cover_the_wait() {
        assert!(call_budget(ASK_TOOL, &json!({"deadline_seconds": 600})).unwrap() > Duration::from_secs(600));
        assert!(call_budget("kybern_read_file", &json!({})).is_none());
    }
}
