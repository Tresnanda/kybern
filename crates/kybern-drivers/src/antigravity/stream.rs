//! Maps one `agy` turn's `stream-json` output to [`DriverEvent`]s.
//!
//! The mapper is a pure state machine over parsed lines, so the recorded
//! fixtures in `tests.rs` exercise all of it without a process.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::time::Instant;

use kybern_protocol::rpc::{Problem, ProblemAction, ProblemKind};
use kybern_protocol::{EventOrigin, ProviderKind, StopReason, ToolCall, Usage};
use serde_json::Value;

use super::SIGN_IN;
use super::tools;
use crate::DriverEvent;

/// How the `result` event ended the turn.
#[derive(Debug, PartialEq)]
enum Outcome {
    Success { response: String },
    Interrupted,
    Failed(String),
}

pub(crate) struct TurnMapper {
    home: Option<PathBuf>,
    conversation: Option<String>,
    started: Instant,
    saw_init: bool,
    /// Whether this turn reached the model (saw an assistant or tool step).
    reached_model: bool,
    /// Whether this turn failed with Claude's invalid/missing thinking signature error.
    conversation_poisoned: bool,
    /// Text of each `agent_response` step, as streamed so far.
    messages: HashMap<u64, String>,
    /// The last assistant message that carried text: its id and text.
    last_message: Option<(String, String)>,
    started_tools: HashSet<u64>,
    /// Steps that are `agy` reading its own MCP tool schemas: nothing is shown for them.
    hidden_tools: HashSet<u64>,
    counted_usage: HashSet<u64>,
    usage: Usage,
    outcome: Option<Outcome>,
    error_event: Option<String>,
    /// This turn wrote an `error_message` step, `agy`'s record of a run that failed.
    error_step: bool,
}

impl TurnMapper {
    pub(crate) fn new(home: Option<PathBuf>) -> Self {
        Self::resumed(home, None)
    }

    pub(crate) fn resumed(home: Option<PathBuf>, conversation: Option<String>) -> Self {
        Self {
            home,
            conversation,
            started: Instant::now(),
            saw_init: false,
            reached_model: false,
            conversation_poisoned: false,
            messages: HashMap::new(),
            last_message: None,
            started_tools: HashSet::new(),
            hidden_tools: HashSet::new(),
            counted_usage: HashSet::new(),
            usage: Usage::default(),
            outcome: None,
            error_event: None,
            error_step: false,
        }
    }

    pub(crate) fn conversation(&self) -> Option<&str> {
        self.conversation.as_deref()
    }

    /// Whether `agy` got far enough to open a conversation for the prompt.
    pub(crate) fn saw_init(&self) -> bool {
        self.saw_init
    }

    /// Whether this turn failed with a poisoned thinking signature, so the
    /// session must drop its `--conversation` id instead of reusing it.
    pub(crate) fn conversation_poisoned(&self) -> bool {
        self.conversation_poisoned
    }

    /// The final text of a run that ended in success (titles).
    pub(crate) fn one_shot_answer(&self) -> Option<String> {
        match &self.outcome {
            Some(Outcome::Success { response }) if !response.trim().is_empty() => Some(response.trim().to_string()),
            _ => self.last_message.as_ref().map(|(_, text)| text.trim().to_string()).filter(|text| !text.is_empty()),
        }
    }

    fn message_id(&self, update: &Value, index: u64) -> String {
        let conversation = update.get("conversation_id").and_then(Value::as_str).or(self.conversation.as_deref()).unwrap_or("agy");
        format!("{conversation}:{index}")
    }

    fn tool_call_id(&self, update: &Value, index: u64) -> String {
        format!("agy:{}", self.message_id(update, index))
    }

    pub(crate) fn handle(&mut self, line: &Value) -> Vec<DriverEvent> {
        match line.get("event").and_then(Value::as_str) {
            Some("init") => self.init(line),
            Some("step_update") => line.get("step_update").map(|update| self.step(update)).unwrap_or_default(),
            Some("result") => {
                if let Some(result) = line.get("result") {
                    self.result(result);
                }
                Vec::new()
            }
            Some("error") => {
                let text = ["error", "message"]
                    .iter()
                    .find_map(|key| line.get(*key).and_then(Value::as_str))
                    .or_else(|| line.pointer("/error/message").and_then(Value::as_str));
                self.error_event = Some(text.unwrap_or("Antigravity reported an error").to_string());
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    fn init(&mut self, line: &Value) -> Vec<DriverEvent> {
        self.saw_init = true;
        if let Some(id) = line.get("conversation_id").and_then(Value::as_str).filter(|id| !id.is_empty()) {
            self.conversation = Some(id.to_string());
        }
        let Some(session_id) = self.conversation.clone() else { return Vec::new() };
        let model = line.pointer("/init/model").and_then(Value::as_str).map(str::to_string);
        vec![DriverEvent::SessionBound { session_id, model }]
    }

    fn step(&mut self, update: &Value) -> Vec<DriverEvent> {
        let Some(index) = update.get("step_index").and_then(Value::as_u64) else { return Vec::new() };
        if self.conversation.is_none() {
            self.conversation = update.get("conversation_id").and_then(Value::as_str).map(str::to_string);
        }
        let state = update.get("state").and_then(Value::as_str);
        let done = state == Some("DONE");
        match update.get("step_type").and_then(Value::as_str) {
            Some("agent_response") => {
                self.reached_model = true;
                self.agent_response(update, index, done)
            }
            Some("error_message") => {
                self.error_step = true;
                Vec::new()
            }
            // A tool that fails ends in ERROR, not DONE: it still needs its result card.
            Some("tool") => {
                self.reached_model = true;
                self.tool(update, index, done || matches!(state, Some("ERROR" | "FAILED" | "CANCELED" | "CANCELLED")))
            }
            _ => Vec::new(),
        }
    }

    fn agent_response(&mut self, update: &Value, index: u64, done: bool) -> Vec<DriverEvent> {
        let id = self.message_id(update, index);
        let mut events = Vec::new();
        if let Some(delta) = update.get("text_delta").and_then(Value::as_str).filter(|delta| !delta.is_empty()) {
            self.messages.entry(index).or_default().push_str(delta);
            events.push(DriverEvent::TextDelta { message_id: id.clone(), origin: EventOrigin::Root, delta: delta.to_string() });
        }
        if done {
            self.count_usage(update, index);
            // A step with no text (planning before tool calls) is not a message.
            if let Some(text) = self.messages.get(&index).filter(|text| !text.trim().is_empty()) {
                self.last_message = Some((id.clone(), text.clone()));
                events.push(DriverEvent::MessageCompleted {
                    message_id: id,
                    origin: EventOrigin::Root,
                    text: text.clone(),
                    thinking: None,
                });
            }
        }
        events
    }

    /// Per-step usage summed for this turn; `result.usage` is cumulative over the conversation.
    fn count_usage(&mut self, update: &Value, index: u64) {
        let Some(usage) = update.get("usage").filter(|_| self.counted_usage.insert(index)) else { return };
        let number = |key: &str| usage.get(key).and_then(Value::as_u64).unwrap_or(0);
        self.usage.input_tokens += number("input_tokens");
        // `agy`'s `output_tokens` already includes `thinking_tokens` (`input + output = total`).
        self.usage.output_tokens += number("output_tokens");
        self.usage.cache_read_tokens += number("cache_read_tokens");
    }

    fn tool(&mut self, update: &Value, index: u64, done: bool) -> Vec<DriverEvent> {
        let id = self.tool_call_id(update, index);
        let info = update.get("tool_info");
        let name =
            update.get("tool_name").and_then(Value::as_str).or_else(|| info.and_then(|info| info.get("name")).and_then(Value::as_str));
        let Some(name) = name else { return Vec::new() };
        let mut events = Vec::new();
        if self.started_tools.insert(index) {
            let params = info.and_then(|info| info.get("parameters")).cloned().unwrap_or(Value::Null);
            let conversation = self.conversation.clone();
            let (kybern_name, input) = tools::normalize(name, &params, |name| {
                conversation.as_deref().and_then(|c| tools::transcript_args(self.home.as_deref(), c, index, name))
            });
            if tools::reads_own_mcp_schema(&kybern_name, &input) {
                self.hidden_tools.insert(index);
            } else {
                events.push(DriverEvent::ToolStarted(ToolCall { id: id.clone(), name: kybern_name, input, parent_id: None }));
            }
        }
        if done && !self.hidden_tools.contains(&index) {
            let output = info
                .and_then(|info| info.get("output"))
                .and_then(Value::as_str)
                .filter(|output| !output.is_empty())
                .or_else(|| error_text(update.get("error")))
                .or_else(|| error_text(info.and_then(|info| info.get("error"))))
                .unwrap_or("")
                .to_string();
            let failed_state = matches!(update.get("state").and_then(Value::as_str), Some("ERROR" | "FAILED" | "CANCELED" | "CANCELLED"));
            let is_error = failed_state
                || info.is_some_and(|info| info.get("error").is_some_and(|error| !error.is_null()))
                || tools::exited_nonzero(&output);
            events.push(DriverEvent::ToolCompleted { tool_call_id: id, output: Value::String(output), is_error });
        }
        events
    }

    fn result(&mut self, result: &Value) {
        if self.conversation.is_none() {
            self.conversation = result.get("conversation_id").and_then(Value::as_str).map(str::to_string);
        }
        let status = result.get("status").and_then(Value::as_str).unwrap_or("");
        let response = result.get("response").and_then(Value::as_str).unwrap_or("");
        let error = result.get("error").and_then(Value::as_str).unwrap_or("").trim();
        self.outcome = Some(if status.eq_ignore_ascii_case("SUCCESS") {
            Outcome::Success { response: response.to_string() }
        } else if self.stale_error(result, response, error) {
            // `agy` (1.5.12) repeats the error of an earlier turn on every later turn of
            // that conversation, even one that answered and exited 0. This turn wrote no
            // error step, so the error is not its own: the answer stands.
            tracing::warn!(target: "kybern::antigravity", error, "agy repeated an earlier turn's error after a complete answer; ignoring it");
            Outcome::Success { response: response.to_string() }
        } else if error.eq_ignore_ascii_case("interrupted") {
            Outcome::Interrupted
        } else if error.is_empty() {
            Outcome::Failed(result.get("finished_reason").and_then(Value::as_str).unwrap_or("").to_string())
        } else {
            Outcome::Failed(error.to_string())
        });
    }

    /// An `error` result whose error belongs to an earlier turn: this turn answered,
    /// ended for `error` (not a timeout or an interrupt) and wrote no error step.
    fn stale_error(&self, result: &Value, response: &str, error: &str) -> bool {
        let reason = result.get("finished_reason").and_then(Value::as_str).unwrap_or("");
        !self.error_step
            && reason.eq_ignore_ascii_case("error")
            && !error.is_empty()
            && !error.eq_ignore_ascii_case("interrupted")
            && !response.trim().is_empty()
    }

    /// The events that end the turn, once the process has gone.
    pub(crate) fn finish(&mut self, code: Option<i32>, stderr: Option<&str>, interrupted: bool) -> Vec<DriverEvent> {
        let duration_ms = self.started.elapsed().as_millis() as u64;
        let usage = self.usage.clone();
        let completed = |stop_reason| DriverEvent::TurnCompleted {
            stop_reason,
            usage: usage.clone(),
            cost_usd: None,
            duration_ms,
            anchors: Default::default(),
        };
        let outcome = self.outcome.take();
        match outcome {
            Some(Outcome::Success { response }) => {
                let mut events = self.reconcile_final_text(&response);
                events.push(completed(StopReason::Completed));
                events
            }
            Some(Outcome::Interrupted) => vec![completed(StopReason::Interrupted)],
            Some(Outcome::Failed(_)) if interrupted => vec![completed(StopReason::Interrupted)],
            Some(Outcome::Failed(error)) => {
                if is_invalid_thinking_signature(&error) {
                    self.conversation_poisoned = true;
                }
                vec![failed(&error, self.reached_model)]
            }
            // No result at all: killed (an interrupt that had to escalate), or it crashed.
            None if interrupted => vec![completed(StopReason::Interrupted)],
            None => {
                let raw = stderr.map(str::to_string).or_else(|| self.error_event.take());
                vec![match (raw, code) {
                    (Some(raw), _) => {
                        if is_invalid_thinking_signature(&raw) {
                            self.conversation_poisoned = true;
                        }
                        failed(&raw, self.reached_model)
                    }
                    (None, Some(0)) | (None, None) => {
                        DriverEvent::turn_failed(ProviderKind::Antigravity, "Antigravity ended without an answer. Send your message again.")
                    }
                    (None, Some(code)) => DriverEvent::turn_failed(
                        ProviderKind::Antigravity,
                        format!("Antigravity exited with code {code}. Send your message again, or pick another agent."),
                    ),
                }]
            }
        }
    }

    /// `result.response` is the authoritative final text. Fix up the last
    /// message if streaming missed some of it, or add it if nothing streamed.
    fn reconcile_final_text(&mut self, response: &str) -> Vec<DriverEvent> {
        if response.trim().is_empty() {
            return Vec::new();
        }
        match &self.last_message {
            Some((_, text)) if text.trim() == response.trim() => Vec::new(),
            Some((id, _)) => vec![DriverEvent::MessageCompleted {
                message_id: id.clone(),
                origin: EventOrigin::Root,
                text: response.to_string(),
                thinking: None,
            }],
            None => {
                let id = format!("{}:result", self.conversation.as_deref().unwrap_or("agy"));
                self.last_message = Some((id.clone(), response.to_string()));
                vec![
                    DriverEvent::TextDelta { message_id: id.clone(), origin: EventOrigin::Root, delta: response.to_string() },
                    DriverEvent::MessageCompleted { message_id: id, origin: EventOrigin::Root, text: response.to_string(), thinking: None },
                ]
            }
        }
    }
}

/// An error field is a string or an object with a `message`.
fn error_text(value: Option<&Value>) -> Option<&str> {
    let value = value?;
    value.as_str().or_else(|| value.get("message").and_then(Value::as_str))
}

/// Claude rejects a saved thinking block without a valid signature. That block
/// sits in `agy`'s saved conversation, so every later turn with `--conversation`
/// fails the same way until the thread moves to a fresh conversation.
pub fn is_invalid_thinking_signature(text: &str) -> bool {
    let bytes = text.as_bytes();
    let needle = "messages.";
    let mut offset = 0;
    while let Some(pos) = text[offset..].find(needle) {
        let start = offset + pos;
        let boundary_ok = start == 0 || (!bytes[start - 1].is_ascii_alphanumeric() && bytes[start - 1] != b'_');
        offset = start + needle.len();
        if !boundary_ok {
            continue;
        }
        let rest = &text[offset..];
        let digits1 = rest.bytes().take_while(|byte| byte.is_ascii_digit()).count();
        if digits1 == 0 {
            continue;
        }
        let Some(after_content) = rest[digits1..].strip_prefix(".content.") else { continue };
        let digits2 = after_content.bytes().take_while(|byte| byte.is_ascii_digit()).count();
        if digits2 == 0 {
            continue;
        }
        let tail = &after_content[digits2..];
        if tail.starts_with(".thinking.signature: Field required") || tail.starts_with(": Invalid `signature` in `thinking` block") {
            return true;
        }
    }
    false
}

/// Whether `raw` is a Google/Antigravity HTTP 404 (`Error 404, …` or `NOT_FOUND (code 404): …`).
fn is_not_found_error(raw: &str) -> bool {
    let lower = raw.to_ascii_lowercase();
    lower.contains("not_found (code 404)")
        || lower.contains("error 404,")
        || lower.contains("http 404")
        || (lower.contains("404") && lower.contains("status: not_found"))
}

/// A failed run, in Antigravity's friendly words, with the cause the raw text names.
fn failed(raw: &str, reached_model: bool) -> DriverEvent {
    let problem = crate::failure::classify(ProviderKind::Antigravity, raw).or_else(|| {
        if is_invalid_thinking_signature(raw) {
            return Some(
                Problem::new(ProblemKind::Internal, raw)
                    .with_subject("antigravity")
                    .with_copy(
                        "Antigravity's saved conversation can no longer continue",
                        "Send your message again to continue in a fresh conversation with this thread's context.",
                    )
                    .with_action(ProblemAction::retry("Try again")),
            );
        }
        if is_not_found_error(raw) {
            return Some(if reached_model {
                // A 404 after the model already answered in this turn is a transient edge error.
                Problem::new(ProblemKind::Internal, raw)
                    .with_subject("antigravity")
                    .with_copy("Antigravity hit a temporary error", "Send your message again to continue.")
                    .with_action(ProblemAction::retry("Try again"))
            } else {
                // A 404 before the model answered is an unknown or unentitled model.
                Problem::new(ProblemKind::NotFound, raw)
                    .with_subject("antigravity")
                    .with_copy("Antigravity couldn't use this model", "Choose another model, then send your message again.")
                    .with_action(
                        ProblemAction::new("choose_model", "Choose another model")
                            .with_params(serde_json::json!({ "provider": "antigravity" })),
                    )
            });
        }
        None
    });
    DriverEvent::TurnFailed { error: friendly_error(raw), problem }
}

/// A sentence that says what to do next, whatever `agy` printed.
pub(crate) fn friendly_error(raw: &str) -> String {
    if crate::failure::is_signed_out(ProviderKind::Antigravity, raw) {
        return SIGN_IN.to_string();
    }
    if is_invalid_thinking_signature(raw) {
        return "Antigravity's saved conversation can no longer be sent to the model. Send your message again to continue in a fresh conversation with this thread's context.".to_string();
    }
    let raw: String = raw.trim().chars().take(300).collect();
    if raw.is_empty() {
        return "Antigravity stopped without saying why. Send your message again, or pick another agent.".to_string();
    }
    format!("Antigravity stopped: {}. Send your message again, or pick another agent.", raw.trim_end_matches(['.', ' ']))
}
