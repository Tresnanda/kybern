//! Maps one `agy` turn's `stream-json` output to [`DriverEvent`]s.
//!
//! The mapper is a pure state machine over parsed lines, so the recorded
//! fixtures in `tests.rs` exercise all of it without a process.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::time::Instant;

use kybern_protocol::{EventOrigin, StopReason, ToolCall, Usage};
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
            messages: HashMap::new(),
            last_message: None,
            started_tools: HashSet::new(),
            hidden_tools: HashSet::new(),
            counted_usage: HashSet::new(),
            usage: Usage::default(),
            outcome: None,
            error_event: None,
        }
    }

    pub(crate) fn conversation(&self) -> Option<&str> {
        self.conversation.as_deref()
    }

    /// Whether `agy` got far enough to open a conversation for the prompt.
    pub(crate) fn saw_init(&self) -> bool {
        self.saw_init
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
            Some("agent_response") => self.agent_response(update, index, done),
            // A tool that fails ends in ERROR, not DONE: it still needs its result card.
            Some("tool") => self.tool(update, index, done || matches!(state, Some("ERROR" | "FAILED" | "CANCELED" | "CANCELLED"))),
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
        // Thinking is billed as output and no text of it is streamed.
        self.usage.output_tokens += number("output_tokens") + number("thinking_tokens");
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
        self.outcome = Some(if status.eq_ignore_ascii_case("SUCCESS") {
            Outcome::Success { response: result.get("response").and_then(Value::as_str).unwrap_or("").to_string() }
        } else {
            let error = result.get("error").and_then(Value::as_str).unwrap_or("").trim();
            if error.eq_ignore_ascii_case("interrupted") {
                Outcome::Interrupted
            } else if error.is_empty() {
                Outcome::Failed(result.get("finished_reason").and_then(Value::as_str).unwrap_or("").to_string())
            } else {
                Outcome::Failed(error.to_string())
            }
        });
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
            Some(Outcome::Failed(error)) => vec![DriverEvent::TurnFailed { error: friendly_error(&error) }],
            // No result at all: killed (an interrupt that had to escalate), or it crashed.
            None if interrupted => vec![completed(StopReason::Interrupted)],
            None => {
                let raw = stderr.map(str::to_string).or_else(|| self.error_event.take());
                vec![DriverEvent::TurnFailed {
                    error: match (raw, code) {
                        (Some(raw), _) => friendly_error(&raw),
                        (None, Some(0)) | (None, None) => "Antigravity ended without an answer. Send your message again.".to_string(),
                        (None, Some(code)) => {
                            format!("Antigravity exited with code {code}. Send your message again, or pick another agent.")
                        }
                    },
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

/// A sentence that says what to do next, whatever `agy` printed.
pub(crate) fn friendly_error(raw: &str) -> String {
    let lower = raw.to_ascii_lowercase();
    if ["authenticat", "oauth", "unauthorized", "sign in", "sign-in", "login", "log in", "credential", "401"]
        .iter()
        .any(|needle| lower.contains(needle))
    {
        return SIGN_IN.to_string();
    }
    let raw: String = raw.trim().chars().take(300).collect();
    if raw.is_empty() {
        return "Antigravity stopped without saying why. Send your message again, or pick another agent.".to_string();
    }
    format!("Antigravity stopped: {}. Send your message again, or pick another agent.", raw.trim_end_matches(['.', ' ']))
}
