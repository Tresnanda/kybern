//! Fold Cursor SDK InteractionUpdate events into Kybern's native event stream.
//! Child deltas always retain their task origin; they never become root text.
use std::collections::{HashMap, HashSet};

use kybern_protocol::*;
use serde_json::{Value, json};

use crate::{DriverEvent, DriverRuntimeTask, DriverRuntimeTaskUpdate, TurnAnchors};

#[derive(Default)]
struct Message {
    id: String,
    text: String,
    thinking: String,
    thinking_open: bool,
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
        match update["type"].as_str().unwrap_or("") {
            "text-delta" | "thinking-delta" => {
                let Some(text) = update["text"].as_str().filter(|s| !s.is_empty()) else { return };
                let thinking = update["type"] == "thinking-delta";
                if thinking && self.messages.get(scope).is_some_and(|m| !m.text.is_empty()) {
                    self.flush(scope, out);
                }
                let origin = self.origin(scope);
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
                    message.text.push_str(text);
                    out.push(DriverEvent::TextDelta { message_id: message.id.clone(), origin, delta: text.into() });
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
                // Preserve explicit identity when supplied. Never attach a
                // parallel shell's output to whichever command started last.
                let explicit = event["callId"].as_str().or_else(|| update["callId"].as_str());
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
                format!("mcp__{}__{}", input["providerIdentifier"].as_str().unwrap_or("mcp"), input["toolName"].as_str().unwrap_or("tool"))
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
        if let Some(text) = result["result"].as_str().filter(|s| !s.is_empty()) {
            let final_text = text.strip_prefix(&self.root_completed).unwrap_or(text);
            if !final_text.is_empty() && (self.messages.contains_key("root") || self.last_root != text) {
                self.message("root").text = final_text.to_string();
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
        if status == "finished" || status == "cancelled" {
            out.push(DriverEvent::TurnCompleted {
                stop_reason: if status == "cancelled" { StopReason::Interrupted } else { StopReason::Completed },
                usage: if result["usage"].is_object() { usage(&result["usage"]) } else { self.usage.clone() },
                cost_usd: None, // Local billed usage IDs differ from SDK run IDs.
                duration_ms: result["durationMs"].as_u64().unwrap_or(0),
                anchors: TurnAnchors { turn_id: self.run.clone(), previous_end: None },
            });
        } else {
            out.push(DriverEvent::TurnFailed {
                error: result
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or("Cursor SDK run failed. Send again to resume the conversation.")
                    .into(),
            });
        }
        *self = Self::default();
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
            "run_completed" => self.finish(&value["result"], &mut out),
            "run_failed" => self.finish(&json!({"status":"error", "error":{"message":value["error"]}}), &mut out),
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
}

fn shell_text(event: &Value) -> String {
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
}
