//! A delegated agent's question reaches the agent that delegated it.
//!
//! When a delegated child raises a plain question (see
//! [`ApprovalRequest::agent_answerable`]: never an approval, password, secret,
//! sign-in, permission, pick or form), three things happen:
//!
//! - a blocking `kybern_agent_wait` (or `kybern_agent_delegate` in wait mode)
//!   on that child returns early with `has_pending_question`;
//! - otherwise, after the delegation debounce, the parent gets a notice from
//!   Kybern, steered into its running turn or queued. A queued notice is taken
//!   back when the question is answered first;
//! - the parent may read it with `kybern_pending_questions` and answer it with
//!   `kybern_answer_question`. The first answer wins, the user's or the
//!   agent's, and the record names the agent that answered.

use std::time::Duration;

use anyhow::{Result, anyhow, bail};
use chrono::Utc;
use kybern_protocol::*;
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use super::Orchestrator;

pub(crate) const LIST_TOOL: &str = "kybern_pending_questions";
pub(crate) const ANSWER_TOOL: &str = "kybern_answer_question";

pub(crate) fn is_tool(name: &str) -> bool {
    matches!(name, LIST_TOOL | ANSWER_TOOL)
}

/// Longest option preview a delegating agent reads, in characters.
const PREVIEW_CHARS: usize = 600;

pub(crate) fn tool_definitions() -> Vec<kybern_drivers::NativeToolDefinition> {
    vec![
        kybern_drivers::NativeToolDefinition {
            name: LIST_TOOL.into(),
            description: concat!(
                "List the questions your delegated agents are waiting on, with their options. Read-only. Questions only: approvals, passwords, ",
                "secrets, sign-ins and permissions are the user's alone and are not listed. Pass thread_id to read one agent's questions."
            )
            .into(),
            input_schema: json!({
                "type": "object", "additionalProperties": false,
                "properties": {"thread_id": {"type": ["string", "null"], "format": "uuid"}},
                "required": []
            }),
        },
        kybern_drivers::NativeToolDefinition {
            name: ANSWER_TOOL.into(),
            description: concat!(
                "Answer a question one of your delegated agents is waiting on, for the user. Answer only when the answer follows from your task or ",
                "the user's instructions; otherwise leave it to the user, who sees it in Kybern. The first answer wins: if the user answered first you get ",
                "status \"already_answered\". answers holds one entry per question: its id from kybern_pending_questions and the chosen option labels ",
                "(or your own text where the question allows it). The record shows that you answered."
            )
            .into(),
            input_schema: json!({
                "type": "object", "additionalProperties": false,
                "properties": {
                    "request_id": {"type": "string", "format": "uuid", "description": "The request_id from kybern_pending_questions."},
                    "answers": {"type": "array", "minItems": 1, "maxItems": 8, "items": {
                        "type": "object", "additionalProperties": false,
                        "properties": {
                            "id": {"type": ["string", "null"], "description": "The question's id. May be left out when there is one question."},
                            "answers": {"type": "array", "minItems": 1, "maxItems": 8, "items": {"type": "string", "minLength": 1, "maxLength": 2000}}
                        },
                        "required": ["answers"]
                    }}
                },
                "required": ["request_id", "answers"]
            }),
        },
    ]
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ListArgs {
    #[serde(default)]
    thread_id: Option<ThreadId>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AnswerArgs {
    request_id: ApprovalId,
    answers: Vec<AgentAnswer>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AgentAnswer {
    #[serde(default)]
    id: Option<String>,
    answers: Vec<String>,
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max { text.to_owned() } else { text.chars().take(max).collect::<String>() + "…" }
}

/// What a delegating agent sees of one waiting question.
pub(super) fn question_view(child: &Thread, approval: &ApprovalRequest) -> Value {
    let mut view = json!({
        "request_id": approval.id,
        "thread_id": child.id,
        "title": child.title,
        "asked_at": approval.created_at,
        "questions": approval.user_input_questions().iter().map(|question| json!({
            "id": question.id,
            "header": question.header,
            "question": question.question,
            "options": question.options.iter().map(|option| {
                let mut item = json!({ "label": option.label });
                if let Some(description) = &option.description {
                    item["description"] = json!(description);
                }
                if let Some(preview) = &option.preview {
                    item["preview"] = json!(clip(preview, PREVIEW_CHARS));
                }
                item
            }).collect::<Vec<_>>(),
            "multi_select": question.multi_select,
            "allow_custom": question.allow_custom,
        })).collect::<Vec<_>>(),
    });
    if let Some(info) = &child.delegation {
        view["task_id"] = json!(info.task_id);
    }
    if let Some(ends) = approval.input.pointer("/deadline/ends_at") {
        view["default_picked_at"] = ends.clone();
    }
    view
}

/// Why a request is not the agent's to answer, in words that say what to do instead.
fn refusal(approval: &ApprovalRequest, child: &Thread) -> String {
    let what = match approval.tool_name.as_str() {
        SECRET_REQUEST_TOOL => "a secret",
        PROMPT_REQUEST_TOOL => "a password prompt",
        LOGIN_REQUEST_TOOL => "a sign-in",
        PERMISSION_REQUEST_TOOL => "a macOS permission",
        PICK_REQUEST_TOOL => "a request to point at something",
        "mcp_elicitation" | "ui_confirm" => "a form or confirmation",
        _ if approval.pending_kind() == PendingRequestKind::Approval => "an approval",
        _ => "a request with a hidden answer",
    };
    format!("That is {what}, which only the user can answer. Tell the user that \"{}\" is waiting on it in Kybern.", child.title)
}

impl Orchestrator {
    pub(super) async fn execute_child_question_tool(&self, caller: &Thread, name: &str, arguments: Value) -> Result<Value> {
        match name {
            LIST_TOOL => {
                let args: ListArgs = serde_json::from_value(arguments)
                    .map_err(|error| anyhow!("Invalid arguments for {LIST_TOOL}: {error}. Pass nothing, or thread_id."))?;
                let mut questions = self.descendant_questions(caller.id)?;
                if let Some(thread_id) = args.thread_id {
                    questions.retain(|(child, _)| child.id == thread_id);
                }
                let mut result = json!({
                    "questions": questions.iter().map(|(child, approval)| question_view(child, approval)).collect::<Vec<_>>(),
                });
                if questions.is_empty() {
                    result["note"] = json!("None of your agents is waiting on a question.");
                }
                Ok(result)
            }
            ANSWER_TOOL => {
                let args: AnswerArgs = serde_json::from_value(lenient_answers(arguments)).map_err(|error| {
                    anyhow!("Invalid arguments for {ANSWER_TOOL}: {error}. Pass request_id and answers: [{{id, answers: [labels]}}].")
                })?;
                self.answer_child_question(caller, args).await
            }
            _ => Err(anyhow!("unknown question tool")),
        }
    }

    /// Every waiting question an agent below `caller` asked that `caller` may answer.
    pub(super) fn descendant_questions(&self, caller: ThreadId) -> Result<Vec<(Thread, ApprovalRequest)>> {
        let mut out = Vec::new();
        for child in self.delegation_descendants(caller)? {
            for approval in self.inner.store.approvals_pending(Some(child.id))? {
                if approval.agent_answerable() {
                    out.push((child.clone(), approval));
                }
            }
        }
        Ok(out)
    }

    async fn answer_child_question(&self, caller: &Thread, args: AnswerArgs) -> Result<Value> {
        let unknown = || anyhow!("Unknown request_id. Call {LIST_TOOL} to see the questions your agents are waiting on.");
        let (approval, resolved) = self.inner.store.approval_get(args.request_id)?.ok_or_else(unknown)?;
        let child = self.inner.store.thread_get(approval.thread_id)?.ok_or_else(unknown)?;
        if child.delegation.is_none() || !self.is_descendant_of(caller.id, &child)? {
            bail!("That question is not from an agent you delegated. Answer only your own agents' questions.");
        }
        if !approval.agent_answerable() {
            bail!(refusal(&approval, &child));
        }
        if resolved {
            return Ok(json!({ "status": "already_answered", "note": "It was answered before your answer arrived. Nothing was changed." }));
        }
        let questions = approval.user_input_questions();
        let mut answers = Vec::new();
        for (index, answer) in args.answers.into_iter().enumerate() {
            let id = match answer.id.as_deref().map(str::trim).filter(|id| !id.is_empty()) {
                Some(id) => questions
                    .iter()
                    .find(|question| question.id == id || question.question == id)
                    .map(|question| question.id.clone())
                    .ok_or_else(|| anyhow!("No question has the id \"{id}\". Use the ids from {LIST_TOOL}."))?,
                None if questions.len() == 1 => questions[0].id.clone(),
                None => questions
                    .get(index)
                    .map(|question| question.id.clone())
                    .ok_or_else(|| anyhow!("Give each answer the id of its question."))?,
            };
            answers.push(UserInputAnswer { id, answers: answer.answers, attachments: Vec::new() });
        }
        let response = encode_answers(&approval, &answers, |_| None).map_err(|message| anyhow!(message))?;
        let by = RequestAnswerer { thread_id: caller.id, title: answerer_title(caller) };
        match self.respond_approval_as(approval.id, ApprovalDecision::Submit { response }, Some(by)).await {
            Ok(()) => Ok(json!({ "status": "answered", "thread_id": child.id, "title": child.title })),
            Err(error) if self.inner.store.approval_get(approval.id)?.is_some_and(|(_, resolved)| resolved) => {
                tracing::debug!(%error, "a child question was answered first");
                Ok(json!({ "status": "already_answered", "note": "It was answered before your answer arrived. Nothing was changed." }))
            }
            Err(error) => Err(error),
        }
    }

    /// Follow request events of delegated children. Called by `emit` for every
    /// stored event; it returns at once and does its work in a task.
    pub(super) fn track_child_question(&self, event: &ThreadEvent) {
        let Ok(runtime) = tokio::runtime::Handle::try_current() else { return };
        match &event.payload {
            EventPayload::ApprovalRequested { approval } | EventPayload::UserInputRequested { approval } if approval.agent_answerable() => {
                let (this, approval) = (self.clone(), approval.clone());
                runtime.spawn(async move {
                    if let Err(error) = this.child_question_raised(approval).await {
                        tracing::debug!(%error, "could not tell a parent about its agent's question");
                    }
                });
            }
            EventPayload::ApprovalResolved { approval_id, .. } => {
                let notice = {
                    let mut questions = self.inner.delegation.questions.lock().unwrap_or_else(|error| error.into_inner());
                    questions.inline.remove(approval_id);
                    questions.notices.remove(approval_id)
                };
                if let Some((parent, message_id)) = notice {
                    let this = self.clone();
                    runtime.spawn(async move {
                        // Answered while the notice still waited in the queue: take it back.
                        if this.inner.store.queue_list(Some(parent)).is_ok_and(|queued| queued.iter().any(|m| m.id == message_id)) {
                            let _ = this.remove_queued(parent, message_id);
                        }
                    });
                }
            }
            _ => {}
        }
    }

    async fn child_question_raised(&self, approval: ApprovalRequest) -> Result<()> {
        let Some(child) = self.inner.store.thread_get(approval.thread_id)? else { return Ok(()) };
        let Some(info) = child.delegation.clone() else { return Ok(()) };
        // A blocked wait on this child returns with the question.
        self.inner.delegation.changed.notify_waiters();
        let delay = Duration::from_millis(self.inner.delegation.debounce_ms.load(std::sync::atomic::Ordering::Relaxed));
        tokio::time::sleep(delay).await;
        let still_waiting = self.inner.store.approval_get(approval.id)?.is_some_and(|(_, resolved)| !resolved);
        let delivered = self.inner.delegation.questions.lock().unwrap_or_else(|error| error.into_inner()).inline.contains(&approval.id);
        if !still_waiting || delivered {
            return Ok(());
        }
        let Some(parent) = self.inner.store.thread_get(info.parent_thread_id)? else { return Ok(()) };
        if parent.status == ThreadStatus::Archived {
            return Ok(());
        }
        let first = approval.user_input_questions().first().map(|question| clip(&question.question, 200)).unwrap_or_default();
        let deadline =
            if approval.input.pointer("/deadline/ends_at").is_some() { " (it picks its default if nobody answers in time)" } else { "" };
        let body = format!(
            "Your agent \"{}\" (task {}, thread {}) is waiting on a question{deadline}: \"{first}\". Read it with {LIST_TOOL} and answer it with {ANSWER_TOOL} if the answer follows from your task or the user's instructions; otherwise leave it to the user, who sees it in Kybern. If it is no longer pending, it was answered.",
            child.title, info.task_id, child.id
        );
        let now = Utc::now();
        let record = ThreadMessageRecord {
            id: Uuid::now_v7(),
            operation_id: Uuid::now_v7(),
            from_thread_id: None,
            to_thread_id: parent.id,
            purpose: ThreadMessagePurpose::Message,
            reply_to: None,
            body,
            delivery: ThreadMessageDelivery::Steer,
            state: ThreadMessageState::Queued,
            held_reason: None,
            created_at: now,
            updated_at: now,
        };
        self.inner.store.thread_message_insert(&record)?;
        let state = self.deliver_thread_message(&record).await?;
        if state == ThreadMessageState::Queued {
            let answered = {
                let mut questions = self.inner.delegation.questions.lock().unwrap_or_else(|error| error.into_inner());
                questions.notices.insert(approval.id, (parent.id, record.id));
                // Answered while the notice was being queued: the resolve event has passed, so take it back here.
                self.inner.store.approval_get(approval.id)?.is_none_or(|(_, resolved)| resolved)
            };
            if answered {
                self.inner.delegation.questions.lock().unwrap_or_else(|error| error.into_inner()).notices.remove(&approval.id);
                let _ = self.remove_queued(parent.id, record.id);
            }
        }
        Ok(())
    }

    /// Questions waiting below these delegations, for a wait that returns early. They count as delivered.
    pub(super) fn waiting_questions(&self, threads: &[Thread]) -> Vec<Value> {
        let mut out = Vec::new();
        for thread in threads {
            let mut below = vec![thread.clone()];
            below.extend(self.delegation_descendants(thread.id).unwrap_or_default());
            for child in below {
                for approval in self.inner.store.approvals_pending(Some(child.id)).unwrap_or_default() {
                    if approval.agent_answerable() {
                        self.inner.delegation.questions.lock().unwrap_or_else(|error| error.into_inner()).inline.insert(approval.id);
                        out.push(question_view(&child, &approval));
                    }
                }
            }
        }
        out
    }
}

/// Agents often send `answers` as a JSON string, or as a `{question: label or [labels]}` map; read both as the list form.
fn lenient_answers(mut arguments: Value) -> Value {
    let Some(answers) = arguments.get_mut("answers") else { return arguments };
    if let Some(text) = answers.as_str()
        && let Ok(parsed) = serde_json::from_str::<Value>(text)
    {
        *answers = parsed;
    }
    if let Some(map) = answers.as_object()
        && !map.contains_key("answers")
    {
        *answers = Value::Array(
            map.iter()
                .map(|(id, value)| {
                    let list = match value {
                        Value::Array(items) => items.clone(),
                        other => vec![other.clone()],
                    };
                    json!({ "id": id, "answers": list })
                })
                .collect(),
        );
    }
    arguments
}

/// How the record names an agent that answered: "Coordinator" for the project's lead.
fn answerer_title(thread: &Thread) -> String {
    if thread.coordinator_project_id.is_some() {
        "Coordinator".into()
    } else if thread.title.trim().is_empty() {
        "Agent".into()
    } else {
        thread.title.clone()
    }
}

/// Bookkeeping for child questions, part of the delegation state.
#[derive(Default)]
pub(super) struct ChildQuestions {
    /// Questions a blocked wait already returned: no notice is sent for them.
    pub(super) inline: std::collections::HashSet<ApprovalId>,
    /// Notices still possibly queued, by question: (parent, queued message id).
    pub(super) notices: std::collections::HashMap<ApprovalId, (ThreadId, MessageId)>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answers_may_come_as_a_string_or_a_map() {
        let want = json!([{ "id": "Which?", "answers": ["Cool"] }]);
        for answers in [json!("{\"Which?\": \"Cool\"}"), json!({ "Which?": "Cool" }), json!({ "Which?": ["Cool"] }), want.clone()] {
            assert_eq!(lenient_answers(json!({ "request_id": "x", "answers": answers }))["answers"], want);
        }
    }
}
