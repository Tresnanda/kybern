//! Fold Cursor SDK InteractionUpdate events into Kybern's native event stream.
//! Child deltas always retain their task origin; they never become root text.
use std::collections::{HashMap, HashSet};

use kybern_protocol::*;
use serde_json::{Value, json};

use crate::{DriverEvent, DriverRuntimeTask, DriverRuntimeTaskUpdate, SteerOutcome, TurnAnchors};

/// After a turn ends, a retryable stream error can make Cursor's SDK resume from
/// an older checkpoint inside the same run. When those resumes save nothing, it
/// ends the run with this error even though the answer was already delivered.
const CURSOR_RESUME_NO_PROGRESS_MESSAGE: &str = "Agent turn stopped after repeated resume attempts made no progress";
const TRANSPORT_SERVER_ERROR: &str = "Something went wrong communicating with the server. Please try again.";
const TRANSPORT_MAX_LINE_LEN: usize = 4096;
/// Known transport error signatures emitted inside Cursor SDK `RetriableError` dumps.
/// Requiring one of these prevents ordinary prose replies beginning with
/// `Error: RetriableError: …` from being dropped as transport dumps.
const RETRIABLE_TRANSPORT_PREFIXES: &[&str] = &[
    "[unavailable]",
    "[aborted]",
    "[deadline_exceeded]",
    "WritableIterable is closed",
    "Connection stalled",
    "Connection failed",
    "Stream ended without turnEnded",
    CURSOR_RESUME_NO_PROGRESS_MESSAGE,
    "write after end",
    "socket hang up",
    "fetch failed",
    "read ECONNRESET",
    "connect ECONNREFUSED",
    "connect ETIMEDOUT",
    "getaddrinfo ENOTFOUND",
    "getaddrinfo EAI_AGAIN",
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "ENOTFOUND",
    "EAI_AGAIN",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CheckpointState {
    Checkpointed,
    NotCheckpointed,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum TurnOutcome {
    Completed,
    Cancelled { checkpointed: CheckpointState },
    Failed { checkpointed: CheckpointState },
}

/// Detects an assistant message whose entire text is a raw Cursor transport error dump
/// (`RetriableError`, `ConnectError`, or server error), optionally followed by a stack trace.
/// Prose or fenced code that mentions the same diagnostic is never misclassified.
#[derive(Default, Clone)]
struct TransportFailure {
    disqualified: bool,
    failure: Option<String>,
    line: String,
}

impl TransportFailure {
    fn from_text(text: &str) -> Self {
        let mut state = Self::default();
        state.push(text);
        state
    }

    fn push(&mut self, text: &str) {
        for (index, part) in text.split('\n').enumerate() {
            if self.disqualified {
                return;
            }
            if index > 0 {
                let completed = std::mem::take(&mut self.line);
                Self::consume_line(&mut self.disqualified, &mut self.failure, &completed);
            }
            if self.line.len() + part.len() > TRANSPORT_MAX_LINE_LEN {
                self.disqualified = true;
                self.failure = None;
                self.line.clear();
                return;
            }
            self.line.push_str(part);
        }
    }

    fn failure(&self) -> Option<String> {
        let mut disqualified = self.disqualified;
        let mut failure = self.failure.clone();
        Self::consume_line(&mut disqualified, &mut failure, &self.line);
        failure
    }

    /// Whether the accumulated message could still turn out to be a standalone transport error dump.
    /// Normal assistant replies disqualify on the first non-matching prefix so they stream immediately.
    fn may_be_dump(&self) -> bool {
        if self.disqualified {
            return false;
        }
        if self.failure.is_some() {
            may_be_transport_error_line(&self.line) || may_be_stack_frame_line(&self.line)
        } else {
            may_be_transport_error_line(&self.line)
        }
    }

    fn consume_line(disqualified: &mut bool, failure: &mut Option<String>, line: &str) {
        if *disqualified {
            return;
        }
        let text = line.trim_end();
        if is_transport_error_line(text) {
            *failure = Some(text.to_string());
        } else if !text.trim().is_empty() && !(failure.is_some() && is_stack_frame_line(text)) {
            *disqualified = true;
            *failure = None;
        }
    }
}

fn is_prefix_of_or_starts_with(text: &str, prefix: &str) -> bool {
    prefix.starts_with(text) || text.starts_with(prefix)
}

fn may_be_transport_error_line(text: &str) -> bool {
    let text = text.trim_end();
    if text.is_empty() {
        return true;
    }
    if TRANSPORT_SERVER_ERROR.starts_with(text) {
        return true;
    }
    const RETRIABLE: &str = "Error: RetriableError: ";
    if is_prefix_of_or_starts_with(text, RETRIABLE) {
        if let Some(rest) = text.strip_prefix(RETRIABLE) {
            return RETRIABLE_TRANSPORT_PREFIXES.iter().any(|prefix| is_prefix_of_or_starts_with(rest, prefix));
        }
        return true;
    }
    const CONNECT: &str = "Error: ConnectError: ";
    if is_prefix_of_or_starts_with(text, CONNECT) {
        if let Some(rest) = text.strip_prefix(CONNECT) {
            return ["[unavailable]", "[aborted]", "[deadline_exceeded]"].iter().any(|code| is_prefix_of_or_starts_with(rest, code));
        }
        return true;
    }
    false
}

fn may_be_stack_frame_line(text: &str) -> bool {
    let text = text.trim_end_matches('\r');
    if text.trim().is_empty() {
        return true;
    }
    let trimmed = text.trim_start();
    if trimmed.len() == text.len() {
        return false;
    }
    "at ".starts_with(trimmed) || is_stack_frame_line(text)
}

fn is_transport_error_line(text: &str) -> bool {
    if text == TRANSPORT_SERVER_ERROR {
        return true;
    }
    if let Some(rest) = text.strip_prefix("Error: RetriableError: ") {
        return RETRIABLE_TRANSPORT_PREFIXES.iter().any(|prefix| rest.starts_with(prefix));
    }
    if let Some(rest) = text.strip_prefix("Error: ConnectError: ") {
        return rest.starts_with("[unavailable]") || rest.starts_with("[aborted]") || rest.starts_with("[deadline_exceeded]");
    }
    false
}

fn is_stack_frame_line(text: &str) -> bool {
    let trimmed = text.trim_start();
    trimmed.len() < text.len() && trimmed.strip_prefix("at").is_some_and(|rest| rest.starts_with(char::is_whitespace))
}

#[derive(Default)]
struct Message {
    id: String,
    text: String,
    /// Byte offset into `text` already emitted via `TextDelta`.
    emitted_len: usize,
    thinking: String,
    thinking_open: bool,
}

impl Message {
    fn push_text(&mut self, text: &str, hold: bool, origin: EventOrigin, out: &mut Vec<DriverEvent>) {
        self.text.push_str(text);
        if !hold && self.emitted_len < self.text.len() {
            let delta = self.text[self.emitted_len..].to_string();
            self.emitted_len = self.text.len();
            out.push(DriverEvent::TextDelta { message_id: self.id.clone(), origin, delta });
        }
    }
}

#[derive(Default)]
pub(super) struct Stream {
    run: Option<String>,
    next_message: usize,
    messages: HashMap<String, Message>,
    tools: HashMap<String, String>,
    completed_tools: HashSet<String>,
    tasks: HashSet<String>,
    completed_tasks: HashSet<String>,
    root_completed: String,
    last_root: String,
    usage: Usage,
    /// The latest root turn ended and no new work has started since.
    turn_ended: bool,
    /// Classifier for the latest root assistant message.
    assistant_reply: TransportFailure,
    last_outcome: Option<TurnOutcome>,
}

impl Stream {
    fn scoped(&self, kind: &str, id: &str) -> String {
        format!("cursor-sdk:{}:{kind}:{id}", self.run.as_deref().unwrap_or("unknown"))
    }

    fn origin(&self, scope: &str) -> EventOrigin {
        if scope == "root" {
            EventOrigin::Root
        } else {
            EventOrigin::Agent { task_id: self.scoped("task", scope), provider_thread_id: None }
        }
    }

    fn flush(&mut self, scope: &str, out: &mut Vec<DriverEvent>) {
        if let Some(message) = self.messages.remove(scope) {
            if message.thinking_open {
                out.push(DriverEvent::ThinkingCompleted { message_id: message.id.clone(), origin: self.origin(scope) });
            }
            if scope == "root" {
                self.root_completed.push_str(&message.text);
                self.last_root.clone_from(&message.text);
            }
            out.push(DriverEvent::MessageCompleted {
                message_id: message.id,
                origin: self.origin(scope),
                text: message.text,
                thinking: (!message.thinking.is_empty()).then_some(message.thinking),
            });
        }
    }

    fn message(&mut self, scope: &str) -> &mut Message {
        if !self.messages.contains_key(scope) {
            self.next_message += 1;
            self.messages
                .insert(scope.into(), Message { id: self.scoped("message", &self.next_message.to_string()), ..Message::default() });
        }
        self.messages.get_mut(scope).unwrap()
    }

    fn update(&mut self, update: &Value, scope: &str, out: &mut Vec<DriverEvent>) {
        let kind = update["type"].as_str().unwrap_or("");
        if scope == "root" {
            match kind {
                "turn-ended" => self.turn_ended = true,
                "step-started"
                | "user-message-appended"
                | "text-delta"
                | "thinking-delta"
                | "partial-tool-call"
                | "tool-call-started"
                | "tool-call-delta" => self.turn_ended = false,
                _ => {}
            }
        }
        match kind {
            "text-delta" | "thinking-delta" => {
                let Some(text) = update["text"].as_str().filter(|s| !s.is_empty()) else { return };
                let thinking = kind == "thinking-delta";
                if thinking && self.messages.get(scope).is_some_and(|m| !m.text.is_empty()) {
                    self.flush(scope, out);
                }
                let origin = self.origin(scope);
                let hold_root = if scope == "root" && !thinking {
                    // Classify each assistant message on its own, so earlier
                    // commentary does not hide a later standalone transport dump.
                    if self.messages.get("root").is_none_or(|m| m.text.is_empty()) {
                        self.assistant_reply = TransportFailure::default();
                    }
                    self.assistant_reply.push(text);
                    self.assistant_reply.may_be_dump() && self.messages.get("root").is_none_or(|m| m.emitted_len == 0)
                } else {
                    false
                };
                let message = self.message(scope);
                if thinking {
                    message.thinking.push_str(text);
                    message.thinking_open = true;
                    out.push(DriverEvent::ThinkingDelta { message_id: message.id.clone(), origin, delta: text.into() });
                } else {
                    if message.thinking_open {
                        message.thinking_open = false;
                        out.push(DriverEvent::ThinkingCompleted { message_id: message.id.clone(), origin: origin.clone() });
                    }
                    message.push_text(text, hold_root, origin, out);
                }
            }
            "thinking-completed" => {
                let origin = self.origin(scope);
                if let Some(message) = self.messages.get_mut(scope).filter(|m| m.thinking_open) {
                    message.thinking_open = false;
                    out.push(DriverEvent::ThinkingCompleted { message_id: message.id.clone(), origin });
                }
            }
            "tool-call-started" | "tool-call-completed" => {
                self.flush(scope, out);
                self.tool(update, scope, out);
            }
            // Partial arguments are not complete tool calls. Wait until start
            // (or completion) before claiming a task exists or rendering input.
            "partial-tool-call" => {}
            "tool-call-delta" => {
                let Some(id) = update["callId"].as_str() else { return };
                if self.tasks.contains(id) && !self.completed_tasks.contains(id) {
                    self.update(&update["taskUpdate"], id, out);
                }
            }
            "shell-output-delta" => {
                let event = &update["event"];
                // In @cursor/sdk 1.2.0, shell-output-delta carries only {case, value} without a toolCallId.
                // Honor an explicit id if a newer SDK adds one; otherwise attribute only when a single shell
                // is running, and drop output when multiple shells run concurrently to avoid misattribution.
                let explicit = event["toolCallId"].as_str().or_else(|| event["callId"].as_str()).or_else(|| update["callId"].as_str());
                let shells: Vec<_> = self.tools.iter().filter(|(_, kind)| *kind == "shell").map(|(id, _)| id.as_str()).collect();
                let id = explicit.or_else(|| (shells.len() == 1).then(|| shells[0]));
                if let Some(id) = id {
                    let text = shell_text(event);
                    if !text.is_empty() {
                        out.push(DriverEvent::ToolOutputDelta { tool_call_id: self.scoped("tool", id), delta: text });
                    }
                }
            }
            "turn-ended" => {
                if scope == "root" && update["usage"].is_object() {
                    self.usage.add(&usage(&update["usage"]));
                }
                // Keep the final message ID alive until RunResult arrives, so
                // its authoritative text can catch up a missing tail in place.
            }
            "summary-started" if scope == "root" => {
                out.push(DriverEvent::Notice { level: NoticeLevel::Info, text: "Cursor is compacting the conversation".into(), data: None })
            }
            "summary-completed" if scope == "root" => {
                out.push(DriverEvent::Notice { level: NoticeLevel::Info, text: "Cursor compacted the conversation".into(), data: None })
            }
            _ => {}
        }
    }

    fn tool(&mut self, update: &Value, scope: &str, out: &mut Vec<DriverEvent>) {
        let Some(raw_id) = update["callId"].as_str() else { return };
        if self.completed_tools.contains(raw_id) {
            return;
        }
        let call = &update["toolCall"];
        let kind = call["type"].as_str().unwrap_or("tool");
        let input = call.get("args").cloned().unwrap_or(json!({}));
        let completed = update["type"] == "tool-call-completed";
        let failed = tool_failed(call);
        let id = self.scoped("tool", raw_id);
        if !self.tools.contains_key(raw_id) {
            self.tools.insert(raw_id.into(), kind.into());
            if kind == "task" {
                self.tasks.insert(raw_id.into());
                out.push(DriverEvent::RuntimeTaskStarted(DriverRuntimeTask {
                    id: self.scoped("task", raw_id),
                    kind: RuntimeTaskKind::Agent,
                    status: RuntimeTaskStatus::Running,
                    title: input["description"]
                        .as_str()
                        .or_else(|| input["prompt"].as_str())
                        .unwrap_or("Cursor subagent")
                        .chars()
                        .take(160)
                        .collect(),
                    detail: input["prompt"].as_str().map(str::to_string),
                    provider_type: Some("task".into()),
                    parent_id: (scope != "root").then(|| self.scoped("task", scope)),
                    tool_call_id: Some(id.clone()),
                    // Cursor task agentId is not a resumable SDK agent (T3
                    // projects it as read-only); do not expose a false handle.
                    provider_thread_id: None,
                    model: input["model"].as_str().map(str::to_string),
                    effort: None,
                    backgrounded: false,
                    last_tool_name: None,
                    usage: None,
                    stats: RuntimeTaskStats::default(),
                    capabilities: RuntimeTaskCapabilities::default(),
                }));
            }
            let name = if kind == "mcp" {
                // Kybern's tools reach the SDK as its custom-tools server.
                let server = match input["providerIdentifier"].as_str().unwrap_or("mcp") {
                    "custom-user-tools" => "kybern",
                    server => server,
                };
                format!("mcp__{server}__{}", input["toolName"].as_str().unwrap_or("tool"))
            } else {
                kind.to_string()
            };
            out.push(DriverEvent::ToolStarted(ToolCall {
                id: id.clone(),
                name,
                input: input.clone(),
                parent_id: (scope != "root").then(|| self.scoped("tool", scope)),
            }));
            if scope != "root" {
                let mut task = DriverRuntimeTaskUpdate::status(self.scoped("task", scope), RuntimeTaskStatus::Running);
                task.last_tool_name = Some(kind.to_string());
                out.push(DriverEvent::RuntimeTaskUpdated(task));
            }
        }
        if !completed {
            return;
        }
        self.tools.remove(raw_id);
        self.completed_tools.insert(raw_id.into());
        out.push(DriverEvent::ToolCompleted {
            tool_call_id: id,
            output: call.get("result").cloned().unwrap_or(Value::Null),
            is_error: failed,
        });
        if kind == "createPlan"
            && !failed
            && let Some(plan) = input["plan"].as_str().filter(|s| !s.is_empty())
        {
            out.push(DriverEvent::MessageCompleted {
                message_id: self.scoped("plan", raw_id),
                origin: self.origin(scope),
                text: plan.into(),
                thinking: None,
            });
        }
        if kind == "task" {
            let result_text = task_result_text(&call["result"]["value"]);
            if !result_text.is_empty() {
                // Reconcile the final child answer under its own origin.
                self.message(raw_id).text = result_text.clone();
            }
            self.flush(raw_id, out);
            self.completed_tasks.insert(raw_id.into());
            let mut task = DriverRuntimeTaskUpdate::status(
                self.scoped("task", raw_id),
                if failed { RuntimeTaskStatus::Failed } else { RuntimeTaskStatus::Completed },
            );
            task.detail = (!result_text.is_empty()).then(|| result_text.chars().take(4000).collect());
            out.push(DriverEvent::RuntimeTaskCompleted(task));
        }
    }

    fn finish(&mut self, result: &Value, out: &mut Vec<DriverEvent>) {
        if self.run.is_none() {
            return;
        }
        let status = result["status"].as_str().unwrap_or("error");
        let checkpointed = checkpoint_state(&result["checkpointed"]);
        let error_message = result.pointer("/error/message").and_then(Value::as_str);
        let resume_no_progress = self.turn_ended && status == "error" && error_message == Some(CURSOR_RESUME_NO_PROGRESS_MESSAGE);
        if !resume_no_progress && let Some(text) = result["result"].as_str().filter(|s| !s.is_empty()) {
            let final_text = text.strip_prefix(&self.root_completed).unwrap_or(text);
            if !final_text.is_empty() && (self.messages.contains_key("root") || self.last_root != text) {
                self.assistant_reply = TransportFailure::from_text(final_text);
                self.message("root").text = final_text.to_string();
            }
        }
        let transport_failure = (status != "cancelled").then(|| self.assistant_reply.failure()).flatten();
        if transport_failure.is_some()
            && let Some(message) = self.messages.remove("root")
        {
            // Drop the root transport-error dump text so the transcript shows only the problem row,
            // while preserving and closing any thinking that streamed before the dump.
            if message.thinking_open {
                out.push(DriverEvent::ThinkingCompleted { message_id: message.id.clone(), origin: EventOrigin::Root });
            }
            if !message.thinking.is_empty() {
                out.push(DriverEvent::MessageCompleted {
                    message_id: message.id,
                    origin: EventOrigin::Root,
                    text: String::new(),
                    thinking: Some(message.thinking),
                });
            }
        }
        for scope in self.messages.keys().cloned().collect::<Vec<_>>() {
            self.flush(&scope, out);
        }
        for raw_id in self.tools.keys() {
            out.push(DriverEvent::ToolCompleted {
                tool_call_id: self.scoped("tool", raw_id),
                output: json!({"status": status, "message": "Cursor run ended before this tool completed"}),
                is_error: true,
            });
        }
        for raw_id in self.tasks.difference(&self.completed_tasks) {
            out.push(DriverEvent::RuntimeTaskCompleted(DriverRuntimeTaskUpdate::status(
                self.scoped("task", raw_id),
                if status == "cancelled" { RuntimeTaskStatus::Stopped } else { RuntimeTaskStatus::Failed },
            )));
        }
        if let Some(context) = context_usage(&result["contextUsage"]) {
            out.push(DriverEvent::UsageUpdated(ProviderUsage { context: Some(context), limits: None, prompt_cache: None }));
        }
        let outcome = if let Some(failure) = transport_failure {
            out.push(DriverEvent::turn_failed(ProviderKind::Cursor, failure));
            TurnOutcome::Failed { checkpointed }
        } else if status == "finished" || resume_no_progress {
            if resume_no_progress {
                tracing::warn!(run_id = ?self.run, "Cursor run ended after repeated resume attempts made no progress after turn-ended; treating as completed");
            }
            out.push(DriverEvent::TurnCompleted {
                stop_reason: StopReason::Completed,
                usage: if result["usage"].is_object() { usage(&result["usage"]) } else { self.usage.clone() },
                cost_usd: None, // Local billed usage IDs differ from SDK run IDs.
                duration_ms: result["durationMs"].as_u64().unwrap_or(0),
                anchors: TurnAnchors { turn_id: self.run.clone(), previous_end: None },
            });
            TurnOutcome::Completed
        } else if status == "cancelled" {
            out.push(DriverEvent::TurnCompleted {
                stop_reason: StopReason::Interrupted,
                usage: if result["usage"].is_object() { usage(&result["usage"]) } else { self.usage.clone() },
                cost_usd: None,
                duration_ms: result["durationMs"].as_u64().unwrap_or(0),
                anchors: TurnAnchors { turn_id: self.run.clone(), previous_end: None },
            });
            TurnOutcome::Cancelled { checkpointed }
        } else {
            out.push(DriverEvent::turn_failed(
                ProviderKind::Cursor,
                error_message.unwrap_or("Cursor SDK run failed. Send again to resume the conversation."),
            ));
            TurnOutcome::Failed { checkpointed }
        };
        *self = Self { last_outcome: Some(outcome), ..Self::default() };
    }

    pub(super) fn take_outcome(&mut self) -> Option<TurnOutcome> {
        self.last_outcome.take()
    }

    pub(super) fn handle(&mut self, value: &Value) -> Vec<DriverEvent> {
        let mut out = Vec::new();
        match value["type"].as_str().unwrap_or("") {
            "run_started" => {
                *self = Self { run: value["runId"].as_str().map(str::to_string), ..Self::default() };
                out.push(DriverEvent::ResponseStarted);
            }
            "update" if self.run.as_deref() == value["runId"].as_str() && self.run.is_some() => {
                self.update(&value["update"], "root", &mut out)
            }
            "notice" => {
                if let Some(text) = value["text"].as_str().filter(|s| !s.is_empty()) {
                    let level = match value["level"].as_str() {
                        Some("error") => NoticeLevel::Error,
                        Some("warning") => NoticeLevel::Warning,
                        _ => NoticeLevel::Info,
                    };
                    out.push(DriverEvent::Notice { level, text: text.to_string(), data: None });
                }
            }
            "steer_settled" => {
                if let Some(steer_id) = value["steerId"].as_str().filter(|s| !s.is_empty()) {
                    let outcome = match value["outcome"].as_str() {
                        Some("complete_delivered") => SteerOutcome::Delivered,
                        _ => SteerOutcome::RevertToFollowup,
                    };
                    out.push(DriverEvent::SteerSettled { steer_id: steer_id.to_string(), outcome });
                }
            }
            "run_completed" => self.finish(&value["result"], &mut out),
            "run_failed" => self.finish(
                &json!({
                    "status": "error",
                    "error": {"message": value["error"]},
                    "checkpointed": value["checkpointed"],
                    "contextUsage": value["contextUsage"],
                }),
                &mut out,
            ),
            _ => {}
        }
        out
    }

    pub(super) fn exited(&mut self) -> Vec<DriverEvent> {
        let mut out = Vec::new();
        self.finish(&json!({"status":"error", "error":{"message":"Cursor SDK process exited during the run. Send again to resume the saved conversation."}}), &mut out);
        out
    }
}

fn checkpoint_state(value: &Value) -> CheckpointState {
    match value {
        Value::Bool(true) => CheckpointState::Checkpointed,
        Value::Bool(false) => CheckpointState::NotCheckpointed,
        Value::String(s) if s == "unknown" => CheckpointState::Unknown,
        _ => CheckpointState::Unknown,
    }
}

fn context_usage(value: &Value) -> Option<ContextUsage> {
    let used_tokens = value.get("usedTokens")?.as_u64()?;
    let window_tokens = value.get("maxTokens")?.as_u64().filter(|&max| max > 0)?;
    Some(ContextUsage { used_tokens, window_tokens })
}

fn usage(value: &Value) -> Usage {
    Usage {
        input_tokens: value["inputTokens"].as_u64().unwrap_or(0),
        output_tokens: value["outputTokens"].as_u64().unwrap_or(0),
        cache_read_tokens: value["cacheReadTokens"].as_u64().unwrap_or(0),
        cache_write_tokens: value["cacheWriteTokens"].as_u64().unwrap_or(0),
    }
}

fn tool_failed(call: &Value) -> bool {
    call.pointer("/result/status").and_then(Value::as_str) == Some("error")
        || call.pointer("/result/value/isError").and_then(Value::as_bool) == Some(true)
        || (call["type"].as_str() == Some("shell")
            && call.pointer("/result/status").and_then(Value::as_str) == Some("success")
            && call.pointer("/result/value/exitCode").and_then(Value::as_i64).is_some_and(|code| code != 0))
}

fn shell_text(event: &Value) -> String {
    if matches!(event["case"].as_str(), Some("stdout" | "stderr"))
        && let Some(data) = event.pointer("/value/data").and_then(Value::as_str)
    {
        return data.to_string();
    }
    event["text"]
        .as_str()
        .or_else(|| event["output"].as_str())
        .or_else(|| event["delta"].as_str())
        .or_else(|| event.pointer("/stdout/data").and_then(Value::as_str))
        .or_else(|| event.pointer("/stderr/data").and_then(Value::as_str))
        .unwrap_or("")
        .to_string()
}

fn task_result_text(value: &Value) -> String {
    let final_answer = value["conversationSteps"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|step| {
            if step["type"] == "assistantMessage" {
                step.pointer("/message/text").and_then(Value::as_str)
            } else {
                step.pointer("/assistantMessage/text").and_then(Value::as_str)
            }
        })
        .rfind(|text| !text.is_empty());
    // Earlier assistant steps are narration already flushed around child
    // tools. Only the last answer can replace the currently streamed tail.
    let mut parts: Vec<_> = final_answer.into_iter().collect();
    if let Some(suffix) = value["resultSuffix"].as_str().filter(|s| !s.is_empty()) {
        parts.push(suffix);
    }
    parts.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    fn started() -> Stream {
        let mut stream = Stream::default();
        stream.handle(&json!({"type":"run_started","runId":"r1"}));
        stream
    }
    fn update(stream: &mut Stream, value: Value) -> Vec<DriverEvent> {
        stream.handle(&json!({"type":"update","runId":"r1","update":value}))
    }

    #[test]
    fn final_text_catches_up_in_place_and_usage_is_not_double_counted() {
        let mut stream = started();
        let deltas = update(&mut stream, json!({"type":"text-delta","text":"Final **ans"}));
        let id = match &deltas[0] {
            DriverEvent::TextDelta { message_id, .. } => message_id.clone(),
            _ => panic!(),
        };
        update(&mut stream, json!({"type":"turn-ended","usage":{"inputTokens":10,"outputTokens":3}}));
        let events = stream.handle(&json!({"type":"run_completed","result":{"status":"finished","result":"Final **answer**.","usage":{"inputTokens":10,"outputTokens":3}}}));
        assert!(events.iter().any(|event| matches!(event, DriverEvent::MessageCompleted { message_id, text, .. } if message_id == &id && text == "Final **answer**.")));
        assert!(events.iter().any(
            |event| matches!(event, DriverEvent::TurnCompleted { usage, .. } if usage.input_tokens == 10 && usage.output_tokens == 3)
        ));
        assert!(stream.exited().is_empty());
    }

    #[test]
    fn child_output_and_nested_tools_never_become_root_output() {
        let mut stream = started();
        let events = update(
            &mut stream,
            json!({"type":"tool-call-started","callId":"task1","toolCall":{"type":"task","args":{"description":"Research","model":"child-model","agentId":"not-resumable"}}}),
        );
        assert!(events.iter().any(|event| matches!(event, DriverEvent::RuntimeTaskStarted(task) if task.model.as_deref() == Some("child-model") && task.provider_thread_id.is_none())));
        let child = update(
            &mut stream,
            json!({"type":"tool-call-delta","callId":"task1","taskUpdate":{"type":"text-delta","text":"Child answer"}}),
        );
        assert!(matches!(&child[0], DriverEvent::TextDelta { origin: EventOrigin::Agent { .. }, .. }));
        let nested = update(
            &mut stream,
            json!({"type":"tool-call-delta","callId":"task1","taskUpdate":{"type":"tool-call-started","callId":"read1","toolCall":{"type":"read","args":{"path":"README.md"}}}}),
        );
        assert!(
            nested.iter().any(
                |event| matches!(event, DriverEvent::ToolStarted(call) if call.parent_id.as_deref() == Some("cursor-sdk:r1:tool:task1"))
            )
        );
        let end = stream.handle(&json!({"type":"run_completed","result":{"status":"cancelled"}}));
        assert!(!end.iter().any(|event| matches!(event, DriverEvent::MessageCompleted { origin: EventOrigin::Root, .. })));
        assert!(
            end.iter()
                .any(|event| matches!(event, DriverEvent::RuntimeTaskCompleted(task) if task.status == Some(RuntimeTaskStatus::Stopped)))
        );
    }

    #[test]
    fn a_run_that_needs_a_sign_in_fails_with_a_signed_out_problem() {
        let mut stream = started();
        let events = stream.handle(&json!({"type":"run_failed","runId":"r1","error":"Authentication required"}));
        let Some(DriverEvent::TurnFailed { error, problem }) = events.last() else { panic!("{events:?}") };
        assert_eq!(error, "Authentication required");
        let problem = problem.as_ref().expect("a signed-out problem");
        assert_eq!((problem.kind, problem.subject.as_deref()), (kybern_protocol::rpc::ProblemKind::SignedOut, Some("cursor")));
        // A crash with no words stays a plain failure.
        let mut crashed = started();
        assert!(matches!(crashed.exited().last(), Some(DriverEvent::TurnFailed { problem: None, .. })));
    }

    #[test]
    fn plans_are_readable_and_failures_close_open_work() {
        let mut stream = started();
        let plan = "# Plan\n\n1. Inspect\n2. Implement";
        let events = update(
            &mut stream,
            json!({"type":"tool-call-completed","callId":"p","toolCall":{"type":"createPlan","args":{"plan":plan},"result":{"status":"success","value":{}}}}),
        );
        assert!(events.iter().any(|event| matches!(event, DriverEvent::MessageCompleted { text, .. } if text == plan)));
        update(&mut stream, json!({"type":"tool-call-started","callId":"s","toolCall":{"type":"shell","args":{"command":"sleep 30"}}}));
        let events = stream.exited();
        assert!(events.iter().any(|event| matches!(event, DriverEvent::ToolCompleted { is_error: true, .. })));
        assert!(matches!(events.last(), Some(DriverEvent::TurnFailed { .. })));
    }

    #[test]
    fn child_final_checkpoint_reconciles_the_tail_without_repeating_narration() {
        let mut stream = started();
        update(&mut stream, json!({"type":"tool-call-started","callId":"task1","toolCall":{"type":"task","args":{}}}));
        update(&mut stream, json!({"type":"tool-call-delta","callId":"task1","taskUpdate":{"type":"text-delta","text":"Final **ans"}}));
        let events = update(
            &mut stream,
            json!({"type":"tool-call-completed","callId":"task1","toolCall":{"type":"task","args":{},"result":{"status":"success","value":{"conversationSteps":[
                {"assistantMessage":{"text":"Let me inspect this."}},
                {"assistantMessage":{"text":"Final **answer**."}}
            ]}}}}),
        );
        assert!(events.iter().any(|event| matches!(event, DriverEvent::MessageCompleted { origin: EventOrigin::Agent { .. }, text, .. } if text == "Final **answer**.")));
        assert!(!events.iter().any(|event| matches!(event, DriverEvent::MessageCompleted { origin: EventOrigin::Root, .. })));
    }

    #[test]
    fn non_zero_shell_exit_code_marks_tool_as_error() {
        let mut stream = started();
        let failed = update(
            &mut stream,
            json!({
                "type": "tool-call-completed",
                "callId": "s1",
                "toolCall": {
                    "type": "shell",
                    "args": {"command": "exit 2"},
                    "result": {"status": "success", "value": {"exitCode": 2, "stderr": "boom"}}
                }
            }),
        );
        assert!(failed.iter().any(|event| matches!(event, DriverEvent::ToolCompleted { is_error: true, .. })));

        let ok = update(
            &mut stream,
            json!({
                "type": "tool-call-completed",
                "callId": "s2",
                "toolCall": {
                    "type": "shell",
                    "args": {"command": "true"},
                    "result": {"status": "success", "value": {"exitCode": 0, "stdout": ""}}
                }
            }),
        );
        assert!(ok.iter().any(|event| matches!(event, DriverEvent::ToolCompleted { is_error: false, .. })));
    }

    #[test]
    fn shell_output_delta_attributes_real_sdk_shape_only_when_one_shell_is_running() {
        let mut stream = started();
        // In @cursor/sdk 1.2.0, `shell-output-delta` carries only `{case, value}` with no toolCallId.
        // Without a running shell, output is dropped.
        assert!(
            update(&mut stream, json!({"type": "shell-output-delta", "event": {"case": "stdout", "value": {"data": "orphan\n"}}}))
                .is_empty()
        );

        // With exactly one running shell, stdout and stderr attach to it; exit carries no output text.
        update(&mut stream, json!({"type":"tool-call-started","callId":"sh1","toolCall":{"type":"shell","args":{"command":"a"}}}));
        let stdout = update(&mut stream, json!({"type": "shell-output-delta", "event": {"case": "stdout", "value": {"data": "hello\n"}}}));
        assert!(matches!(
            stdout.as_slice(),
            [DriverEvent::ToolOutputDelta { tool_call_id, delta }] if tool_call_id == "cursor-sdk:r1:tool:sh1" && delta == "hello\n"
        ));
        let stderr = update(&mut stream, json!({"type": "shell-output-delta", "event": {"case": "stderr", "value": {"data": "warn\n"}}}));
        assert!(matches!(
            stderr.as_slice(),
            [DriverEvent::ToolOutputDelta { tool_call_id, delta }] if tool_call_id == "cursor-sdk:r1:tool:sh1" && delta == "warn\n"
        ));
        assert!(
            update(
                &mut stream,
                json!({"type": "shell-output-delta", "event": {"case": "exit", "value": {"code": 0, "cwd": "/tmp", "aborted": false}}})
            )
            .is_empty()
        );

        // When two shells run concurrently, output has no id and is dropped rather than misattributed.
        update(&mut stream, json!({"type":"tool-call-started","callId":"sh2","toolCall":{"type":"shell","args":{"command":"b"}}}));
        assert!(
            update(&mut stream, json!({"type": "shell-output-delta", "event": {"case": "stdout", "value": {"data": "ambiguous\n"}}}))
                .is_empty()
        );

        // Once sh1 finishes, sh2 is the sole running shell again and receives output cleanly.
        update(
            &mut stream,
            json!({"type":"tool-call-completed","callId":"sh1","toolCall":{"type":"shell","args":{"command":"a"},"result":{"status":"success","value":{"exitCode":0}}}}),
        );
        let remaining =
            update(&mut stream, json!({"type": "shell-output-delta", "event": {"case": "stdout", "value": {"data": "from-sh2\n"}}}));
        assert!(matches!(
            remaining.as_slice(),
            [DriverEvent::ToolOutputDelta { tool_call_id, delta }] if tool_call_id == "cursor-sdk:r1:tool:sh2" && delta == "from-sh2\n"
        ));
    }

    #[test]
    fn run_completed_emits_context_usage_before_turn_completed() {
        let mut stream = started();
        let events = stream.handle(&json!({
            "type": "run_completed",
            "result": {
                "status": "finished",
                "contextUsage": {"usedTokens": 42_000, "maxTokens": 200_000},
                "checkpointed": true
            }
        }));
        let usage_pos = events
            .iter()
            .position(|event| {
                matches!(
                    event,
                    DriverEvent::UsageUpdated(ProviderUsage {
                        context: Some(ContextUsage { used_tokens: 42_000, window_tokens: 200_000 }),
                        ..
                    })
                )
            })
            .expect("context usage event");
        let completed_pos = events
            .iter()
            .position(|event| matches!(event, DriverEvent::TurnCompleted { stop_reason: StopReason::Completed, .. }))
            .expect("turn completed event");
        assert!(usage_pos < completed_pos);
        assert_eq!(stream.take_outcome(), Some(TurnOutcome::Completed));
    }

    #[test]
    fn notice_events_forward_to_driver_notice() {
        let mut stream = started();
        let events = stream.handle(&json!({
            "type": "notice",
            "level": "warning",
            "text": "Cursor has no filesystem sandbox on Windows."
        }));
        assert!(matches!(
            events.as_slice(),
            [DriverEvent::Notice { level: NoticeLevel::Warning, text, data: None }]
                if text == "Cursor has no filesystem sandbox on Windows."
        ));
    }

    #[test]
    fn repeated_resume_no_progress_after_turn_ended_completes_cleanly() {
        let mut stream = started();
        update(&mut stream, json!({"type": "text-delta", "text": "All done."}));
        update(&mut stream, json!({"type": "turn-ended"}));
        let events = stream.handle(&json!({
            "type": "run_completed",
            "result": {
                "status": "error",
                "error": {"message": CURSOR_RESUME_NO_PROGRESS_MESSAGE},
                "checkpointed": true
            }
        }));
        assert!(events.iter().any(|event| matches!(event, DriverEvent::TurnCompleted { stop_reason: StopReason::Completed, .. })));
        assert!(!events.iter().any(|event| matches!(event, DriverEvent::TurnFailed { .. })));
        assert_eq!(stream.take_outcome(), Some(TurnOutcome::Completed));

        // Without turn-ended (or if a new step started afterwards), the same error still fails.
        let mut unfinished = started();
        update(&mut unfinished, json!({"type": "text-delta", "text": "Working..."}));
        update(&mut unfinished, json!({"type": "turn-ended"}));
        update(&mut unfinished, json!({"type": "step-started"}));
        let failed = unfinished.handle(&json!({
            "type": "run_completed",
            "result": {
                "status": "error",
                "error": {"message": CURSOR_RESUME_NO_PROGRESS_MESSAGE},
                "checkpointed": false
            }
        }));
        assert!(matches!(failed.last(), Some(DriverEvent::TurnFailed { .. })));
        assert_eq!(unfinished.take_outcome(), Some(TurnOutcome::Failed { checkpointed: CheckpointState::NotCheckpointed }));
    }

    #[test]
    fn transport_error_dump_replies_drop_the_root_message_and_fail_while_prose_completes() {
        for dump in [
            "Error: RetriableError: WritableIterable is closed\n    at onClose (file:///sdk/index.js:12:4)",
            "Error: RetriableError: Connection stalled",
            "Error: ConnectError: [unavailable] transport closed\n    at Stream.end (node:internal/streams:1:1)",
            "Error: ConnectError: [deadline_exceeded] timed out",
            TRANSPORT_SERVER_ERROR,
        ] {
            let mut stream = started();
            let streamed = update(&mut stream, json!({"type": "text-delta", "text": dump}));
            assert!(
                !streamed.iter().any(|event| matches!(event, DriverEvent::TextDelta { origin: EventOrigin::Root, .. })),
                "transport dump must be held back from TextDelta for {dump:?}, got {streamed:?}"
            );
            let events =
                stream.handle(&json!({"type": "run_completed", "result": {"status": "finished", "result": dump, "checkpointed": false}}));
            assert!(
                !events.iter().any(|event| matches!(event, DriverEvent::MessageCompleted { origin: EventOrigin::Root, .. })),
                "transport dump must not flush as a root MessageCompleted for {dump:?}, got {events:?}"
            );
            let Some(DriverEvent::TurnFailed { problem, .. }) = events.last() else {
                panic!("expected TurnFailed for dump {dump:?}, got {events:?}");
            };
            assert_eq!(problem.as_ref().map(|p| p.kind), Some(kybern_protocol::rpc::ProblemKind::Offline));
            assert_eq!(stream.take_outcome(), Some(TurnOutcome::Failed { checkpointed: CheckpointState::NotCheckpointed }));
        }

        // Earlier normal commentary followed by a tool call and then a standalone transport dump keeps
        // the commentary, drops the dump message, and fails the turn.
        let mut after_tool = started();
        let intro = update(&mut after_tool, json!({"type": "text-delta", "text": "Checking files..."}));
        assert!(intro.iter().any(|event| matches!(event, DriverEvent::TextDelta { delta, .. } if delta == "Checking files...")));
        let tool_start = update(
            &mut after_tool,
            json!({"type": "tool-call-started", "callId": "r1", "toolCall": {"type": "read", "args": {"path": "a.rs"}}}),
        );
        assert!(tool_start.iter().any(|event| matches!(event, DriverEvent::MessageCompleted { text, .. } if text == "Checking files...")));
        update(
            &mut after_tool,
            json!({"type": "tool-call-completed", "callId": "r1", "toolCall": {"type": "read", "args": {"path": "a.rs"}, "result": {"status": "success", "value": {}}}}),
        );
        let dump_delta = update(&mut after_tool, json!({"type": "text-delta", "text": "Error: ConnectError: [aborted] stream reset"}));
        assert!(dump_delta.is_empty());
        let events = after_tool.handle(&json!({"type": "run_completed", "result": {"status": "finished", "checkpointed": true}}));
        assert!(!events.iter().any(|event| matches!(event, DriverEvent::MessageCompleted { origin: EventOrigin::Root, .. })));
        assert!(matches!(events.last(), Some(DriverEvent::TurnFailed { .. })));

        // Normal prose (including one-line replies starting with `Error: RetriableError: …` that are
        // not real transport dumps) releases and completes cleanly.
        for normal in [
            "I saw this error in the logs:\nError: RetriableError: WritableIterable is closed",
            "Error: RetriableError: [internal] something else",
            "Error: RetriableError: this error means your retry middleware gave up after three attempts.",
            "Error: ConnectError: [internal] not a transport disconnect",
            "Error: ConnectError: [aborted] stream reset\nHere is what caused that error.",
            "Something else went right.",
        ] {
            let mut stream = started();
            // Feed in small chunks to exercise held-prefix release mid-stream.
            let mut streamed = String::new();
            for chunk in normal.as_bytes().chunks(7) {
                let text = std::str::from_utf8(chunk).unwrap();
                for event in update(&mut stream, json!({"type": "text-delta", "text": text})) {
                    if let DriverEvent::TextDelta { origin: EventOrigin::Root, delta, .. } = event {
                        streamed.push_str(&delta);
                    }
                }
            }
            let events = stream.handle(&json!({"type": "run_completed", "result": {"status": "finished", "checkpointed": true}}));
            assert_eq!(streamed, normal, "normal reply must stream intact without loss or duplication");
            assert!(
                events
                    .iter()
                    .any(|event| matches!(event, DriverEvent::MessageCompleted { origin: EventOrigin::Root, text, .. } if text == normal)),
                "expected MessageCompleted for normal reply {normal:?}, got {events:?}"
            );
            assert!(
                events.iter().any(|event| matches!(event, DriverEvent::TurnCompleted { stop_reason: StopReason::Completed, .. })),
                "expected completed for normal reply {normal:?}, got {events:?}"
            );
        }
    }

    #[test]
    fn dropped_transport_dump_keeps_and_closes_preceding_thinking() {
        // Case 1: thinking streamed, closed by dump text-delta, then dump dropped at finish.
        let mut stream = started();
        let thinking = update(&mut stream, json!({"type": "thinking-delta", "text": "Checking the repo."}));
        let message_id = match &thinking[0] {
            DriverEvent::ThinkingDelta { message_id, .. } => message_id.clone(),
            other => panic!("expected ThinkingDelta, got {other:?}"),
        };
        let dump_events = update(&mut stream, json!({"type": "text-delta", "text": "Error: ConnectError: [aborted] stream reset"}));
        assert!(
            dump_events.iter().any(|event| matches!(event, DriverEvent::ThinkingCompleted { message_id: id, .. } if id == &message_id))
        );
        assert!(!dump_events.iter().any(|event| matches!(event, DriverEvent::TextDelta { .. })));
        let events = stream.handle(&json!({"type": "run_completed", "result": {"status": "finished", "checkpointed": true}}));
        assert!(
            events.iter().any(|event| matches!(
                event,
                DriverEvent::MessageCompleted { message_id: id, origin: EventOrigin::Root, text, thinking: Some(thought) }
                    if id == &message_id && text.is_empty() && thought == "Checking the repo."
            )),
            "dropped dump must still close and preserve thinking via MessageCompleted: {events:?}"
        );
        assert!(matches!(events.last(), Some(DriverEvent::TurnFailed { .. })));

        // Case 2: thinking stayed open and dump arrived only in run_completed.result.
        let mut open_thinking = started();
        let thinking = update(&mut open_thinking, json!({"type": "thinking-delta", "text": "Still reasoning."}));
        let message_id = match &thinking[0] {
            DriverEvent::ThinkingDelta { message_id, .. } => message_id.clone(),
            other => panic!("expected ThinkingDelta, got {other:?}"),
        };
        let events = open_thinking.handle(&json!({
            "type": "run_completed",
            "result": {"status": "finished", "result": TRANSPORT_SERVER_ERROR, "checkpointed": false}
        }));
        let tc_pos = events
            .iter()
            .position(|event| matches!(event, DriverEvent::ThinkingCompleted { message_id: id, .. } if id == &message_id))
            .expect("ThinkingCompleted must close open thinking");
        let mc_pos = events
            .iter()
            .position(|event| {
                matches!(
                    event,
                    DriverEvent::MessageCompleted { message_id: id, origin: EventOrigin::Root, text, thinking: Some(thought) }
                        if id == &message_id && text.is_empty() && thought == "Still reasoning."
                )
            })
            .expect("MessageCompleted must preserve thinking");
        assert!(tc_pos < mc_pos);
        assert!(matches!(events.last(), Some(DriverEvent::TurnFailed { .. })));
    }

    #[test]
    fn held_released_and_held_again_emits_each_text_byte_once() {
        let mut message = Message { id: "m1".into(), ..Message::default() };
        let mut out = Vec::new();
        message.push_text("first ", true, EventOrigin::Root, &mut out);
        assert!(out.is_empty());
        message.push_text("part", false, EventOrigin::Root, &mut out);
        message.push_text(" second ", true, EventOrigin::Root, &mut out);
        message.push_text("part", false, EventOrigin::Root, &mut out);
        let deltas: Vec<&str> = out
            .iter()
            .filter_map(|event| match event {
                DriverEvent::TextDelta { delta, .. } => Some(delta.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(deltas, vec!["first part", " second part"]);
        assert_eq!(deltas.concat(), "first part second part");
    }

    #[test]
    fn steer_settled_and_unknown_checkpoint_state_parse_cleanly() {
        let mut stream = started();
        let delivered = stream.handle(&json!({"type": "steer_settled", "steerId": "s1", "outcome": "complete_delivered"}));
        assert!(matches!(
            delivered.as_slice(),
            [DriverEvent::SteerSettled { steer_id, outcome: SteerOutcome::Delivered }] if steer_id == "s1"
        ));
        let reverted = stream.handle(&json!({"type": "steer_settled", "steerId": "s2", "outcome": "revert_to_followup"}));
        assert!(matches!(
            reverted.as_slice(),
            [DriverEvent::SteerSettled { steer_id, outcome: SteerOutcome::RevertToFollowup }] if steer_id == "s2"
        ));
        let _ = stream.handle(&json!({"type": "run_completed", "result": {"status": "cancelled", "checkpointed": "unknown"}}));
        assert_eq!(stream.take_outcome(), Some(TurnOutcome::Cancelled { checkpointed: CheckpointState::Unknown }));
    }
}
