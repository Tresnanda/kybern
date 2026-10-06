//! Notes and tasks for agents: native tools that let a chat's agent search and
//! read the user's notes and tasks, file new ones, append to them, check off
//! acceptance criteria and claim a task as its run.
//!
//! The user owns these items. Agents fully edit only what an agent created
//! (`created_by_thread`); on the user's own items they may only append, tick
//! criteria and change priority. Nothing here deletes an item or closes a task.
//! Writes ask the user through a daemon-owned approval card in supervised modes
//! (the computer-use pattern) and record an operation receipt, so a retried
//! call returns the first result instead of filing twice.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use anyhow::{Result, anyhow, bail, ensure};
use kybern_protocol::methods::{
    Note, NoteId, NoteScope, NoteSummary, NotesUpdateParams, TaskItem, TaskItemId, TaskItemsUpdateParams, TaskRunState, TaskScope,
    TaskStatus,
};
use kybern_protocol::*;
use kybern_store::{NewTask, NoteError, TaskRunPatch, TaskStatusChange};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::tasks::{NOTE_MENTION_PREFIX, TASK_MENTION_PREFIX, priority_label, status_label};
use super::{DaemonAnswer, LiveSession, Orchestrator};
use crate::app_tools::markdown_link;

/// `tool_name` of the approval card these tools open.
pub(crate) const APPROVAL_TOOL: &str = "kybern_notes_tasks";
/// Tools that read.
const READ_TOOLS: [&str; 4] = ["kybern_notes_search", "kybern_note_read", "kybern_tasks_list", "kybern_task_read"];
/// Tools that write; each asks for approval in supervised modes.
pub(crate) const WRITE_TOOLS: [&str; 6] =
    ["kybern_note_create", "kybern_note_append", "kybern_note_update", "kybern_task_create", "kybern_task_update", "kybern_task_claim"];
/// The daemon's hard limit on tasks one turn may file.
pub(crate) const MAX_TASK_CREATES_PER_TURN: u32 = 10;
/// How much of a body a read returns.
const READ_BODY_MAX_BYTES: usize = 128 * 1024;
/// How much of new text the approval card previews.
const PREVIEW_MAX_BYTES: usize = 2 * 1024;

pub(crate) fn is_tool(name: &str) -> bool {
    READ_TOOLS.contains(&name) || WRITE_TOOLS.contains(&name)
}

/// What these tools remember in memory: threads the user allowed for the rest of
/// their life in this daemon, and how many tasks each thread's current turn filed.
#[derive(Default)]
pub(super) struct AgentItemState {
    allowed_threads: HashSet<ThreadId>,
    task_creates: HashMap<ThreadId, TaskCreates>,
}

/// Tasks one turn filed, and creates of it still waiting for the user or a lock.
/// Both count against [`MAX_TASK_CREATES_PER_TURN`], so parallel calls cannot overshoot.
#[derive(Clone, Copy)]
struct TaskCreates {
    turn_id: TurnId,
    filed: u32,
    reserved: u32,
}

/// One reserved task create. Dropping it without [`CreateReservation::commit`]
/// (a denial, an error, an unanswered card) gives the slot back.
struct CreateReservation {
    orchestrator: Orchestrator,
    thread_id: ThreadId,
    turn_id: TurnId,
    committed: bool,
}

impl CreateReservation {
    /// The task was filed: the slot counts as filed from now on.
    fn commit(mut self) {
        self.committed = true;
        self.orchestrator.settle_task_create(self.thread_id, self.turn_id, true);
    }
}

impl Drop for CreateReservation {
    fn drop(&mut self) {
        if !self.committed {
            self.orchestrator.settle_task_create(self.thread_id, self.turn_id, false);
        }
    }
}

/// A write, checked against the policy and ready to run once the user agrees.
struct Write {
    /// One line for the approval card, such as "Create task 'Fix login' in ade".
    summary: String,
    /// Structured detail for the approval card.
    input: Value,
    action: Action,
}

enum Action {
    CreateNote { scope: NoteScope, project_id: Option<ProjectId>, title: String, body: String },
    AppendNote { target: Option<NoteId>, text: String },
    UpdateNote { id: NoteId, title: Option<String>, body: Option<String>, expected_revision: i64 },
    CreateTask(Box<NewTask>),
    UpdateTask { task: Box<TaskItem>, patch: Box<TaskItemsUpdateParams>, needs_review: bool, changes: Vec<String> },
    ClaimTask { task: Box<TaskItem> },
}

impl Orchestrator {
    /// Run one notes-and-tasks tool for the agent of `thread`.
    pub(super) async fn execute_notes_tasks_tool(
        &self,
        thread: &Thread,
        turn_id: TurnId,
        live: &Arc<LiveSession>,
        name: &str,
        mut arguments: Value,
    ) -> Result<Value> {
        let object = arguments.as_object_mut().ok_or_else(|| anyhow!("tool arguments must be a JSON object"))?;
        let operation_id: Option<OperationId> =
            object.remove("operation_id").filter(|value| !value.is_null()).map(serde_json::from_value).transpose()?;
        match name {
            "kybern_notes_search" => return self.agent_notes_search(parse(arguments)?),
            "kybern_note_read" => return self.agent_note_read(parse(arguments)?),
            "kybern_tasks_list" => return self.agent_tasks_list(thread, parse(arguments)?),
            "kybern_task_read" => return self.agent_task_read(parse(arguments)?),
            _ => {}
        }
        ensure!(WRITE_TOOLS.contains(&name), "unknown Kybern notes and tasks tool: {name}");
        let actor = format!("thread:{}", thread.id);
        if let Some(id) = operation_id
            && let Some(receipt) = self.inner.store.collaboration_operation_receipt::<Value>(id, &actor, name, &arguments)?
        {
            return Ok(receipt);
        }
        // Hold a slot of the per-turn cap from before the user is asked until the
        // task is filed, so parallel calls and open cards cannot pass the cap.
        let reservation = if name == "kybern_task_create" { Some(self.reserve_task_create(thread.id, turn_id)?) } else { None };
        let write = match name {
            "kybern_note_create" => self.plan_note_create(thread, parse(arguments.clone())?)?,
            "kybern_note_append" => self.plan_note_append(parse(arguments.clone())?)?,
            "kybern_note_update" => self.plan_note_update(parse(arguments.clone())?)?,
            "kybern_task_create" => self.plan_task_create(thread, parse(arguments.clone())?)?,
            "kybern_task_update" => self.plan_task_update(thread, parse(arguments.clone())?)?,
            "kybern_task_claim" => self.plan_task_claim(thread, parse(arguments.clone())?)?,
            _ => unreachable!("checked above"),
        };
        // An "Allow once" answer covers one operation: a retry of the same operation
        // may reuse it, another identical call needs its own answer.
        let operation = operation_id.unwrap_or_else(uuid::Uuid::now_v7);
        loop {
            let card = self.notes_tasks_consent(thread, turn_id, live, name, &arguments, &write, operation).await?;

            // One write at a time, so a transport retry waits for the first call's receipt.
            let _ops = self.inner.agent_item_ops.lock().await;
            if let Some(id) = operation_id
                && let Some(receipt) = self.inner.store.collaboration_operation_receipt::<Value>(id, &actor, name, &arguments)?
            {
                return Ok(receipt);
            }
            if let Some(card) = card
                && !self.consume_daemon_approval(live, card, operation).await?
            {
                // A parallel identical call used that answer first: ask again.
                continue;
            }
            if live.turn.lock().await.as_ref().is_none_or(|turn| turn.id != turn_id || turn.completed) {
                bail!("The turn ended before this change was made. Nothing was saved.");
            }
            if let Some(id) = operation_id {
                self.inner.store.collaboration_operation_begin(id, &actor, name, &arguments)?;
            }
            let result = self.apply_write(thread, write.action);
            match (&result, operation_id) {
                (Ok(value), Some(id)) => self.inner.store.collaboration_operation_complete(id, value)?,
                (Err(_), Some(id)) => self.inner.store.collaboration_operation_abandon(id)?,
                _ => {}
            }
            if result.is_ok()
                && let Some(reservation) = reservation
            {
                reservation.commit();
            }
            return result;
        }
    }

    // ---- reads ----

    fn agent_notes_search(&self, args: NotesSearchArgs) -> Result<Value> {
        let limit = args.limit.unwrap_or(20).clamp(1, 50) as usize;
        let summaries: HashMap<NoteId, NoteSummary> =
            self.inner.store.notes_list()?.into_iter().filter(|note| note.deleted_at.is_none()).map(|note| (note.id, note)).collect();
        let in_scope = |note: &NoteSummary| args.project_id.is_none_or(|project_id| note.project_id == Some(project_id));
        let query = args.query.as_deref().map(str::trim).unwrap_or_default();
        let mut results = Vec::new();
        if query.is_empty() {
            let mut recent: Vec<&NoteSummary> = summaries.values().filter(|note| in_scope(note)).collect();
            recent.sort_by(|a, b| b.pinned.cmp(&a.pinned).then(b.updated_at.cmp(&a.updated_at)));
            for note in recent.into_iter().take(limit) {
                let mut row = note_row(note);
                row["snippet"] = json!(note.preview);
                results.push(row);
            }
        } else {
            for hit in self.inner.store.notes_search(query, 200)? {
                let Some(note) = summaries.get(&hit.id).filter(|note| in_scope(note)) else { continue };
                let mut row = note_row(note);
                row["snippet"] = json!(hit.snippet);
                results.push(row);
                if results.len() == limit {
                    break;
                }
            }
        }
        Ok(json!({ "notes": results }))
    }

    fn agent_note_read(&self, args: NoteIdArgs) -> Result<Value> {
        let note = self.live_note(args.note_id)?;
        let mut body = note.body.clone();
        let truncated = cut(&mut body, READ_BODY_MAX_BYTES);
        let mut value = note_row(&note.summary);
        value["body"] = json!(body);
        value["truncated"] = json!(truncated);
        Ok(value)
    }

    fn agent_tasks_list(&self, thread: &Thread, args: TasksListArgs) -> Result<Value> {
        let limit = args.limit.unwrap_or(50).clamp(1, 200) as usize;
        let project = match args.project_id {
            Some(project_id) => Some(project_id),
            None if is_free_chat_project(thread.project_id) => None,
            None => Some(thread.project_id),
        };
        let status = args.status.as_deref().unwrap_or("open");
        let wanted: Option<TaskStatus> =
            match status {
                "open" | "all" => None,
                other => Some(serde_json::from_value(json!(other)).map_err(|_| {
                    anyhow!("Unknown status {other:?}. Use open, all, inbox, todo, running, needs_review, done or canceled.")
                })?),
            };
        let query = args.query.as_deref().map(str::trim).unwrap_or_default().to_lowercase();
        let matches = |task: &TaskItem| {
            let status_ok = match (status, wanted) {
                ("open", _) => !matches!(task.status, TaskStatus::Done | TaskStatus::Canceled),
                (_, Some(wanted)) => task.status == wanted,
                _ => true,
            };
            // A project's list includes the global tasks; global tasks have no project.
            let project_ok = project.is_none_or(|project_id| task.project_id.is_none_or(|id| id == project_id));
            let query_ok = query.is_empty()
                || task.key.to_lowercase().contains(&query)
                || task.title.to_lowercase().contains(&query)
                || task.body.to_lowercase().contains(&query);
            status_ok && project_ok && query_ok
        };
        let all = self.inner.store.task_items_list()?;
        let found: Vec<&TaskItem> = all.iter().filter(|task| matches(task)).collect();
        let truncated = found.len() > limit;
        let tasks: Vec<Value> = found.into_iter().take(limit).map(task_row).collect();
        Ok(json!({ "tasks": tasks, "truncated": truncated }))
    }

    fn agent_task_read(&self, args: TaskRefArgs) -> Result<Value> {
        let task = self.find_task(&args.task)?;
        let store = &self.inner.store;
        let mut body = task.body.clone();
        let truncated = cut(&mut body, READ_BODY_MAX_BYTES);
        let project = task.project_id.and_then(|id| store.project_get(id).ok().flatten()).map(|project| project.name);
        let notes: Vec<Value> = task
            .note_ids
            .iter()
            .map(|id| match store.note_get(*id).ok().flatten().filter(|note| note.summary.deleted_at.is_none()) {
                Some(note) => json!({
                    "id": id, "title": note.summary.title, "link": format!("{NOTE_MENTION_PREFIX}{id}"),
                    "markdown": markdown_link(&note.summary.title, &format!("{NOTE_MENTION_PREFIX}{id}")),
                }),
                None => json!({ "id": id, "title": null, "unavailable": true }),
            })
            .collect();
        let runs: Vec<Value> = task
            .runs
            .iter()
            .map(|run| {
                json!({
                    "number": run.number, "thread_id": run.thread_id, "state": run.state, "provider": run.provider.kind,
                    "started_at": run.started_at, "ended_at": run.ended_at,
                })
            })
            .collect();
        let criteria: Vec<Value> = criteria(&task.body)
            .into_iter()
            .enumerate()
            .map(|(index, item)| json!({ "number": index + 1, "text": item.text, "checked": item.checked }))
            .collect();
        let mut value = task_row(&task);
        let object = value.as_object_mut().expect("task row is an object");
        object.insert("priority_label".into(), json!(priority_label(task.priority)));
        object.insert("status_label".into(), json!(status_label(task.status)));
        object.insert("project_name".into(), json!(project));
        object.insert("body".into(), json!(body));
        object.insert("truncated".into(), json!(truncated));
        object.insert("criteria".into(), json!(criteria));
        object.insert("notes".into(), json!(notes));
        object.insert("runs".into(), json!(runs));
        object.insert("revision".into(), json!(task.revision));
        object.insert("hint".into(), json!("Read a run's conversation with kybern_thread_read and its thread_id."));
        Ok(value)
    }

    // ---- planning writes: policy checks before anyone is asked ----

    fn plan_note_create(&self, thread: &Thread, args: NoteCreateArgs) -> Result<Write> {
        ensure!(!args.title.trim().is_empty(), "Give the note a title.");
        let (scope, project_id) = match resolve_scope(thread, args.scope, None)? {
            Some(project_id) => (NoteScope::Project, Some(project_id)),
            None => (NoteScope::Global, None),
        };
        let place = self.place_label(project_id);
        let title = args.title.trim().to_owned();
        Ok(Write {
            summary: match &place {
                Some(name) => format!("Create note '{title}' in {name}"),
                None => format!("Create global note '{title}'"),
            },
            input: json!({
                "action": "create_note", "kind": "note", "title": title, "project": place, "preview": preview(&args.body),
            }),
            action: Action::CreateNote { scope, project_id, title, body: args.body },
        })
    }

    fn plan_note_append(&self, args: NoteAppendArgs) -> Result<Write> {
        ensure!(!args.text.trim().is_empty(), "Pass the text to append.");
        let (summary, target) = match args.note_id {
            Some(id) => {
                let note = self.live_note(id)?;
                (format!("Append to note '{}'", display_title(&note.summary.title)), json!({ "id": id, "title": note.summary.title }))
            }
            None => ("Append to this chat's note".to_owned(), Value::Null),
        };
        Ok(Write {
            summary,
            input: json!({ "action": "append_note", "kind": "note", "target": target, "preview": preview(&args.text) }),
            action: Action::AppendNote { target: args.note_id, text: args.text },
        })
    }

    fn plan_note_update(&self, args: NoteUpdateArgs) -> Result<Write> {
        let note = self.live_note(args.note_id)?;
        if note.summary.created_by_thread.is_none() {
            bail!("The user wrote this note, so you can only append to it with kybern_note_append. Ask the user before changing it.");
        }
        if note.summary.scope == NoteScope::Thread && args.title.is_some() {
            bail!("A thread's note is titled after its thread. Change only the body.");
        }
        ensure!(args.title.is_some() || args.body.is_some(), "Pass a new title, body or both.");
        // Replacing text without the revision it was based on would silently drop
        // edits the user made since the agent read the note.
        let Some(expected_revision) = args.expected_revision else {
            bail!(
                "Pass expected_revision. Call kybern_note_read for the note's current text and revision, apply your change to that text, and retry."
            );
        };
        if expected_revision != note.summary.revision {
            bail!("{}", stale_note_message(note.summary.revision));
        }
        let mut changes = Vec::new();
        if args.title.is_some() {
            changes.push("title");
        }
        if args.body.is_some() {
            changes.push("body");
        }
        Ok(Write {
            summary: format!("Edit note '{}'", display_title(&note.summary.title)),
            input: json!({
                "action": "update_note", "kind": "note", "target": { "id": note.summary.id, "title": note.summary.title },
                "changes": changes, "title": args.title, "preview": args.body.as_deref().map(preview),
            }),
            action: Action::UpdateNote { id: note.summary.id, title: args.title, body: args.body, expected_revision },
        })
    }

    fn plan_task_create(&self, thread: &Thread, args: TaskCreateArgs) -> Result<Write> {
        ensure!(!args.title.trim().is_empty(), "Give the task a title.");
        let project_id = resolve_scope(thread, args.scope, args.project_id)?;
        let mut body = args.description.as_deref().map(str::trim).unwrap_or_default().to_owned();
        let items: Vec<String> =
            args.criteria.iter().map(|text| text.trim()).filter(|text| !text.is_empty()).map(|text| format!("- [ ] {text}")).collect();
        if !items.is_empty() {
            if !body.is_empty() {
                body.push_str("\n\n");
            }
            body.push_str(&items.join("\n"));
        }
        if !body.is_empty() {
            body.push('\n');
        }
        let priority = args.priority.unwrap_or(0);
        ensure!(priority <= 4, "Priority is 0 (none), 1 (urgent), 2 (high), 3 (medium) or 4 (low).");
        let place = self.place_label(project_id);
        let title = args.title.trim().to_owned();
        Ok(Write {
            summary: match &place {
                Some(name) => format!("Create task '{title}' in {name}"),
                None => format!("Create global task '{title}'"),
            },
            input: json!({
                "action": "create_task", "kind": "task", "title": title, "project": place,
                "priority": priority, "priority_label": priority_label(priority),
                "criteria": items.len(), "preview": preview(&body),
            }),
            action: Action::CreateTask(Box::new(NewTask {
                scope: if project_id.is_some() { TaskScope::Project } else { TaskScope::Global },
                project_id,
                title,
                body,
                status: Some(TaskStatus::Inbox),
                priority,
                note_ids: args.note_ids,
                source_note_id: None,
                created_by_thread: Some(thread.id),
            })),
        })
    }

    fn plan_task_update(&self, thread: &Thread, args: TaskUpdateArgs) -> Result<Write> {
        let task = self.find_task(&args.task)?;
        let agent_authored = task.created_by_thread.is_some();
        if (args.title.is_some() || args.description.is_some()) && !agent_authored {
            bail!(
                "The user wrote {}, so you cannot replace its title or description. You can append to the description, check or uncheck criteria, or change its priority.",
                task.key
            );
        }
        let mut changes = Vec::new();
        let mut needs_review = false;
        let mut status = None;
        match args.status {
            None => {}
            Some(TaskStatus::Done | TaskStatus::Canceled) => {
                bail!("Only the user closes a task as Done or Canceled. Set status needs_review to hand your work over, and tell the user.")
            }
            Some(TaskStatus::Running) => bail!("Claim the task with kybern_task_claim to start working on it."),
            Some(TaskStatus::NeedsReview) => {
                let run = self.inner.store.task_runs_for_thread(thread.id)?.into_iter().find(|(task_id, _)| *task_id == task.id);
                let Some((_, number)) = run else {
                    bail!("Only a chat that runs {} can hand it over for review. Claim it with kybern_task_claim first.", task.key);
                };
                if latest_run_number(&task) != Some(number) {
                    bail!("A newer run of {} replaced this chat, so it cannot hand the task over. Tell the user instead.", task.key);
                }
                match task.status {
                    TaskStatus::NeedsReview => {}
                    TaskStatus::Running => {
                        needs_review = true;
                        changes.push("hand over for review".to_owned());
                    }
                    other => bail!(
                        "{} is {}, not Running, so there is no run to hand over. Claim it with kybern_task_claim first.",
                        task.key,
                        status_label(other)
                    ),
                }
            }
            Some(other) if other != task.status => {
                if !matches!(task.status, TaskStatus::Inbox | TaskStatus::Todo) {
                    bail!(
                        "{} is {}. You can move a task only between Inbox and To do while it is in one of them; ask the user to change it.",
                        task.key,
                        status_label(task.status)
                    );
                }
                changes.push(format!("move to {}", status_label(other)));
                status = Some(other);
            }
            Some(_) => {}
        }

        let mut body = match args.description {
            Some(description) => {
                changes.push("replace the description".into());
                description
            }
            None => task.body.clone(),
        };
        if let Some(text) = args.append.as_deref().map(str::trim).filter(|text| !text.is_empty()) {
            body = append_before_checklist(&body, text);
            changes.push("add to the description".into());
        }
        let (checked, unchecked) = (args.check.len(), args.uncheck.len());
        body = set_criteria(&body, &args.check, true)?;
        body = set_criteria(&body, &args.uncheck, false)?;
        match (checked, unchecked) {
            (0, 0) => {}
            (n, 0) => changes.push(format!("check {n} {}", plural(n, "criterion", "criteria"))),
            (0, n) => changes.push(format!("uncheck {n} {}", plural(n, "criterion", "criteria"))),
            (a, b) => changes.push(format!("check {a} and uncheck {b} criteria")),
        }
        let title = args.title.map(|title| title.trim().to_owned()).filter(|title| *title != task.title);
        if let Some(title) = &title {
            ensure!(!title.is_empty(), "A task needs a title.");
            changes.push(format!("rename to '{title}'"));
        }
        let priority = args.priority.filter(|priority| *priority != task.priority);
        if let Some(priority) = priority {
            ensure!(priority <= 4, "Priority is 0 (none), 1 (urgent), 2 (high), 3 (medium) or 4 (low).");
            changes.push(format!("set priority {}", priority_label(priority)));
        }
        let body = (body != task.body).then_some(body);
        ensure!(!changes.is_empty(), "Nothing to change: {} already looks like that.", task.key);
        let patch = TaskItemsUpdateParams {
            id: task.id,
            expected_revision: Some(task.revision),
            title,
            body,
            status,
            priority,
            scope: None,
            project_id: None,
            note_ids: None,
            pending_followup: None,
            before_id: None,
        };
        let mut summary_changes = changes.clone();
        if let Some(first) = summary_changes.first_mut() {
            *first = capitalize(first);
        }
        Ok(Write {
            summary: format!("{} on {} '{}'", summary_changes.join(", "), task.key, task.title),
            input: json!({
                "action": "update_task", "kind": "task",
                "target": { "id": task.id, "key": task.key, "title": task.title },
                "changes": changes, "preview": args.append.as_deref().map(preview),
            }),
            action: Action::UpdateTask { task: Box::new(task), patch: Box::new(patch), needs_review, changes },
        })
    }

    fn plan_task_claim(&self, thread: &Thread, args: TaskRefArgs) -> Result<Write> {
        let task = self.find_task(&args.task)?;
        if matches!(task.status, TaskStatus::Done | TaskStatus::Canceled) {
            bail!("The user closed {} as {}. Ask the user before working on it again.", task.key, status_label(task.status));
        }
        // A chat runs one task, or the several tasks it was sent with. It cannot take on another.
        let runs = self.inner.store.task_runs_for_thread(thread.id)?;
        if let Some((task_id, _)) = runs.first()
            && !runs.iter().any(|(id, _)| *id == task.id)
        {
            let other = self.inner.store.task_item_get(*task_id)?.map(|task| task.key).unwrap_or_else(|| "another task".into());
            bail!("This chat already works on {other}. Start a new chat for {}.", task.key);
        }
        if let Some(run) = task.runs.last()
            && run.state.is_live()
            && run.thread_id != thread.id
        {
            bail!("{} already has a run in progress in another chat ({}). Do not claim it.", task.key, run.thread_id);
        }
        Ok(Write {
            summary: format!("Work on {} '{}' in this chat", task.key, task.title),
            input: json!({ "action": "claim_task", "kind": "task", "target": { "id": task.id, "key": task.key, "title": task.title } }),
            action: Action::ClaimTask { task: Box::new(task) },
        })
    }

    // ---- consent ----

    /// Ask the user in supervised modes. Returns the card whose one-time answer
    /// this write must consume, or `None` when no card is needed.
    #[allow(clippy::too_many_arguments)]
    async fn notes_tasks_consent(
        &self,
        thread: &Thread,
        turn_id: TurnId,
        live: &Arc<LiveSession>,
        name: &str,
        arguments: &Value,
        write: &Write,
        operation: OperationId,
    ) -> Result<Option<ApprovalId>> {
        if matches!(thread.permission_mode, PermissionMode::FullAccess | PermissionMode::Auto) || self.notes_tasks_allowed(thread.id) {
            return Ok(None);
        }
        let digest = Sha256::digest(serde_json::to_vec(&json!([name, arguments]))?);
        let key = format!("notes_tasks:{}", digest.iter().take(12).map(|byte| format!("{byte:02x}")).collect::<String>());
        let mut input = write.input.clone();
        input["tool"] = json!(name);
        let (card, answer) =
            self.ask_daemon_approval(thread.id, turn_id, live, key, APPROVAL_TOOL, input, write.summary.clone(), Some(operation)).await?;
        match answer {
            DaemonAnswer::Decided(ApprovalDecision::AllowAlways) => {
                self.inner.agent_items.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).allowed_threads.insert(thread.id);
                Ok(None)
            }
            DaemonAnswer::Decided(ApprovalDecision::Deny { reason }) => Err(anyhow!(
                "The user declined: {}{}. Do not retry; continue without it or ask the user.",
                write.summary,
                reason.map(|reason| format!(" ({reason})")).unwrap_or_default()
            )),
            DaemonAnswer::Decided(_) => Ok(Some(card)),
            DaemonAnswer::TurnEnded => bail!("The turn ended before the user answered. Nothing was saved."),
            DaemonAnswer::Pending => bail!(
                "Waiting for the user to approve: {}. The approval is still open; call this tool again with the same arguments after the user answers.",
                write.summary
            ),
        }
    }

    fn notes_tasks_allowed(&self, thread_id: ThreadId) -> bool {
        self.inner.agent_items.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).allowed_threads.contains(&thread_id)
    }

    /// Take one of this turn's task-create slots, or fail when filed and pending
    /// creates already reach the cap.
    fn reserve_task_create(&self, thread_id: ThreadId, turn_id: TurnId) -> Result<CreateReservation> {
        let mut state = self.inner.agent_items.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let entry = state.task_creates.entry(thread_id).or_insert(TaskCreates { turn_id, filed: 0, reserved: 0 });
        if entry.turn_id != turn_id {
            *entry = TaskCreates { turn_id, filed: 0, reserved: 0 };
        }
        if entry.filed + entry.reserved >= MAX_TASK_CREATES_PER_TURN {
            bail!(
                "You have filed (or are waiting to file) {MAX_TASK_CREATES_PER_TURN} tasks this turn, the most allowed. Stop filing tasks and ask the user how to proceed."
            );
        }
        entry.reserved += 1;
        Ok(CreateReservation { orchestrator: self.clone(), thread_id, turn_id, committed: false })
    }

    /// Release a reserved slot; `filed` keeps it as a filed task.
    fn settle_task_create(&self, thread_id: ThreadId, turn_id: TurnId, filed: bool) {
        let mut state = self.inner.agent_items.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(entry) = state.task_creates.get_mut(&thread_id).filter(|entry| entry.turn_id == turn_id) else { return };
        entry.reserved = entry.reserved.saturating_sub(1);
        if filed {
            entry.filed += 1;
        }
    }

    // ---- applying writes ----

    fn apply_write(&self, thread: &Thread, action: Action) -> Result<Value> {
        match action {
            Action::CreateNote { scope, project_id, title, body } => {
                let note = {
                    let _command = self.inner.commands.lock().map_err(|_| anyhow!("command lock poisoned"))?;
                    let note = self.inner.store.note_create_by(scope, project_id, &title, &body, Some(thread.id))?;
                    self.publish_note(note.summary.clone());
                    note
                };
                Ok(note_result("created", &note.summary))
            }
            Action::AppendNote { target, text } => {
                let text = text.trim().to_owned();
                for attempt in 0..2 {
                    let current = match target {
                        Some(id) => Some(self.live_note(id)?),
                        None => self.inner.store.note_for_thread(thread.id)?,
                    };
                    let (revision, existing) = match &current {
                        Some(note) if note.summary.deleted_at.is_some() => {
                            bail!("This chat's note is in Recently deleted. Ask the user to restore it before appending.")
                        }
                        Some(note) => (note.summary.revision, note.body.trim_end()),
                        None => (0, ""),
                    };
                    let body = if existing.is_empty() { text.clone() } else { format!("{existing}\n\n{text}") };
                    let saved = self.note_update(NotesUpdateParams {
                        id: target,
                        thread_id: target.is_none().then_some(thread.id),
                        expected_revision: revision,
                        title: None,
                        body: Some(body),
                    });
                    match saved {
                        Ok(note) => return Ok(note_result("appended", &note.summary)),
                        Err(error) if attempt == 0 && matches!(error.downcast_ref::<NoteError>(), Some(NoteError::Conflict)) => {}
                        Err(error) => return Err(error),
                    }
                }
                bail!("The note kept changing while appending. Read it again and retry.")
            }
            Action::UpdateNote { id, title, body, expected_revision } => {
                let saved = self.note_update(NotesUpdateParams { id: Some(id), thread_id: None, expected_revision, title, body });
                let note = match saved {
                    Ok(note) => note,
                    Err(error) if matches!(error.downcast_ref::<NoteError>(), Some(NoteError::Conflict)) => {
                        let revision = self.live_note(id)?.summary.revision;
                        bail!("{}", stale_note_message(revision))
                    }
                    Err(error) => return Err(error),
                };
                Ok(note_result("updated", &note.summary))
            }
            Action::CreateTask(new) => {
                let task = {
                    let _locks = self.task_locks()?;
                    let task = self.inner.store.task_item_create(*new)?;
                    self.publish_task(task.clone());
                    task
                };
                Ok(task_result("created", &task))
            }
            Action::UpdateTask { task, patch, needs_review, changes } => {
                if needs_review {
                    // Check before writing anything: the task may have moved on while the user was asked.
                    let _locks = self.task_locks()?;
                    self.check_handover(thread, task.id)?;
                }
                let has_patch = patch.title.is_some() || patch.body.is_some() || patch.status.is_some() || patch.priority.is_some();
                let mut updated = if has_patch { self.task_item_update(*patch)? } else { *task };
                if needs_review {
                    let _locks = self.task_locks()?;
                    self.check_handover(thread, updated.id)?;
                    match self.set_task_status_system(updated.id, TaskStatus::NeedsReview, Some(&[TaskStatus::Running]))? {
                        Some(changed) => {
                            self.publish_task(changed.clone());
                            updated = changed;
                        }
                        None => bail!("{} is no longer Running, so it was not handed over. Tell the user.", updated.key),
                    }
                }
                let mut value = task_result("updated", &updated);
                value["changes"] = json!(changes);
                Ok(value)
            }
            Action::ClaimTask { task } => {
                let claimed = {
                    let _locks = self.task_locks()?;
                    let store = &self.inner.store;
                    let current = store.task_item_get(task.id)?.ok_or_else(|| anyhow!("{} was deleted.", task.key))?;
                    let runs = store.task_runs_for_thread(thread.id)?;
                    match runs.iter().find(|(task_id, _)| *task_id == current.id).copied().or_else(|| runs.first().copied()) {
                        Some((task_id, number)) if task_id == current.id => {
                            if latest_run_number(&current) != Some(number) {
                                bail!("A newer run of {} replaced this chat. Do not claim it again.", current.key);
                            }
                            let patch = TaskRunPatch {
                                state: Some(TaskRunState::Running),
                                activity: Some(None),
                                ended_at: Some(None),
                                ..Default::default()
                            };
                            // A combined run reopens every task it holds, so publish them all.
                            let updates = store.task_run_updates(
                                thread.id,
                                patch,
                                Some(TaskStatusChange { status: TaskStatus::Running, only_from: None }),
                            )?;
                            let mut mine = None;
                            for update in updates {
                                if update.task.id == current.id {
                                    mine = Some(update.task);
                                } else {
                                    self.publish_task(update.task);
                                }
                            }
                            mine.unwrap_or(current)
                        }
                        Some(_) => bail!("This chat already works on another task."),
                        None => {
                            if current.runs.last().is_some_and(|run| run.state.is_live()) {
                                bail!("{} already has a run in progress in another chat. Do not claim it.", current.key);
                            }
                            store.task_run_start(current.id, thread.id, &thread.provider, thread.model.as_deref(), &[])?
                        }
                    }
                };
                self.track_task_thread(thread.id);
                self.publish_task(claimed.clone());
                let mut value = task_result("claimed", &claimed);
                value["hint"] = json!("The task shows Running and moves to Needs review when your turn ends. Tell the user what you did.");
                Ok(value)
            }
        }
    }

    /// Whether `thread` may hand task `id` over for review now: it runs the task's
    /// latest run and the task is Running. Call with the task locks held.
    fn check_handover(&self, thread: &Thread, id: TaskItemId) -> Result<()> {
        let store = &self.inner.store;
        let task = store.task_item_get(id)?.ok_or_else(|| anyhow!("The task was deleted. Nothing was handed over."))?;
        match store.task_runs_for_thread(thread.id)?.into_iter().find(|(task_id, _)| *task_id == task.id) {
            Some((_, number)) if latest_run_number(&task) == Some(number) => {}
            Some(_) => {
                bail!("A newer run of {} replaced this chat, so it cannot hand the task over. Tell the user instead.", task.key)
            }
            None => bail!("Only a chat that runs {} can hand it over for review. Claim it with kybern_task_claim first.", task.key),
        }
        ensure!(
            task.status == TaskStatus::Running,
            "{} is {}, not Running, so it was not handed over. Tell the user.",
            task.key,
            status_label(task.status)
        );
        Ok(())
    }

    // ---- lookups ----

    fn live_note(&self, id: NoteId) -> Result<Note> {
        match self.inner.store.note_get(id)? {
            None => bail!("Note {id} not found. Search with kybern_notes_search."),
            Some(note) if note.summary.deleted_at.is_some() => bail!("Note '{}' is in Recently deleted.", note.summary.title),
            Some(note) => Ok(note),
        }
    }

    /// A live task by id or key (such as `ADE-14`), or a `kybern://task/<id>` link.
    fn find_task(&self, reference: &str) -> Result<TaskItem> {
        let reference = reference.trim();
        let reference = reference.strip_prefix(TASK_MENTION_PREFIX).unwrap_or(reference);
        let found = match reference.parse::<uuid::Uuid>() {
            Ok(id) => self.inner.store.task_item_get(id)?,
            Err(_) => self.inner.store.task_item_by_key(reference)?,
        };
        found.ok_or_else(|| anyhow!("Task {reference} not found. List tasks with kybern_tasks_list."))
    }

    fn place_label(&self, project_id: Option<ProjectId>) -> Option<String> {
        project_id.map(|id| self.inner.store.project_get(id).ok().flatten().map_or_else(|| "a project".to_owned(), |project| project.name))
    }
}

// ---- arguments ----

fn parse<T: for<'de> Deserialize<'de>>(arguments: Value) -> Result<T> {
    crate::app_tools::parse(arguments)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ItemScope {
    Project,
    Global,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NotesSearchArgs {
    #[serde(default)]
    query: Option<String>,
    #[serde(default)]
    project_id: Option<ProjectId>,
    #[serde(default)]
    limit: Option<u32>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NoteIdArgs {
    note_id: NoteId,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NoteCreateArgs {
    title: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    scope: Option<ItemScope>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NoteAppendArgs {
    #[serde(default)]
    note_id: Option<NoteId>,
    text: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NoteUpdateArgs {
    note_id: NoteId,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    expected_revision: Option<i64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TasksListArgs {
    #[serde(default)]
    project_id: Option<ProjectId>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    query: Option<String>,
    #[serde(default)]
    limit: Option<u32>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TaskRefArgs {
    task: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TaskCreateArgs {
    title: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    criteria: Vec<String>,
    #[serde(default)]
    priority: Option<u8>,
    #[serde(default)]
    scope: Option<ItemScope>,
    #[serde(default)]
    project_id: Option<ProjectId>,
    #[serde(default)]
    note_ids: Vec<NoteId>,
}

/// A criterion by its text or its 1-based number.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum CriterionRef {
    Number(usize),
    Text(String),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TaskUpdateArgs {
    task: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    append: Option<String>,
    #[serde(default)]
    check: Vec<CriterionRef>,
    #[serde(default)]
    uncheck: Vec<CriterionRef>,
    #[serde(default)]
    priority: Option<u8>,
    #[serde(default)]
    status: Option<TaskStatus>,
}

/// The project a new item goes to: an explicit project, the caller's project, or
/// `None` for a global item. A chat without a project files global items.
fn resolve_scope(thread: &Thread, scope: Option<ItemScope>, project_id: Option<ProjectId>) -> Result<Option<ProjectId>> {
    match (scope, project_id) {
        (Some(ItemScope::Global), Some(_)) => bail!("A global item belongs to no project. Drop project_id or use scope project."),
        (Some(ItemScope::Global), None) => Ok(None),
        (_, Some(project_id)) => Ok(Some(project_id)),
        (Some(ItemScope::Project), None) if is_free_chat_project(thread.project_id) => {
            bail!("This chat has no project. Pass project_id, or use scope global.")
        }
        (None, None) if is_free_chat_project(thread.project_id) => Ok(None),
        (_, None) => Ok(Some(thread.project_id)),
    }
}

// ---- results ----

fn note_row(note: &NoteSummary) -> Value {
    json!({
        "kind": "note",
        "id": note.id,
        "title": note.title,
        "scope": note.scope,
        "project_id": note.project_id,
        "thread_id": note.thread_id,
        "created_by_thread": note.created_by_thread,
        "agent_editable": note.created_by_thread.is_some(),
        "revision": note.revision,
        "updated_at": note.updated_at,
        "link": format!("{NOTE_MENTION_PREFIX}{}", note.id),
        "markdown": markdown_link(&note.title, &format!("{NOTE_MENTION_PREFIX}{}", note.id)),
    })
}

fn note_result(action: &str, note: &NoteSummary) -> Value {
    let mut value = note_row(note);
    value["action"] = json!(action);
    value
}

fn task_row(task: &TaskItem) -> Value {
    let items = criteria(&task.body);
    json!({
        "kind": "task",
        "id": task.id,
        "key": task.key,
        "title": task.title,
        "status": task.status,
        "priority": task.priority,
        "project_id": task.project_id,
        "created_by_thread": task.created_by_thread,
        "agent_editable": task.created_by_thread.is_some(),
        "criteria_done": items.iter().filter(|item| item.checked).count(),
        "criteria_total": items.len(),
        "latest_run": task.runs.last().map(|run| json!({ "thread_id": run.thread_id, "state": run.state })),
        "link": format!("{TASK_MENTION_PREFIX}{}", task.id),
        "markdown": markdown_link(&format!("{} {}", task.key, task.title), &format!("{TASK_MENTION_PREFIX}{}", task.id)),
    })
}

/// The number of the task's newest run.
fn latest_run_number(task: &TaskItem) -> Option<u32> {
    task.runs.iter().map(|run| run.number).max()
}

fn task_result(action: &str, task: &TaskItem) -> Value {
    let mut value = task_row(task);
    value["action"] = json!(action);
    value
}

/// Shorten `text` to at most `max_bytes` on a character boundary; whether it was cut.
fn cut(text: &mut String, max_bytes: usize) -> bool {
    if text.len() <= max_bytes {
        return false;
    }
    let mut end = max_bytes;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    true
}

fn stale_note_message(revision: i64) -> String {
    format!(
        "The note changed since you read it (now revision {revision}). Nothing was saved. Call kybern_note_read, apply your change to its current text, and retry with that expected_revision."
    )
}

fn display_title(title: &str) -> &str {
    if title.trim().is_empty() { "Untitled note" } else { title.trim() }
}

fn preview(text: &str) -> String {
    let mut text = text.trim().to_owned();
    if cut(&mut text, PREVIEW_MAX_BYTES) {
        text.push('…');
    }
    text
}

fn plural<'a>(count: usize, one: &'a str, many: &'a str) -> &'a str {
    if count == 1 { one } else { many }
}

fn capitalize(text: &str) -> String {
    let mut chars = text.chars();
    chars.next().map(|first| first.to_uppercase().chain(chars).collect()).unwrap_or_default()
}

// ---- acceptance criteria ----

/// A top-level checklist line of a task body, as the desktop's task page reads it.
struct Criterion {
    line: usize,
    checked: bool,
    text: String,
}

/// `- [ ] text`, `* [x] text`, `+ [X] text` at the start of a line, outside code fences.
fn criteria(body: &str) -> Vec<Criterion> {
    let mut out = Vec::new();
    let mut in_fence = false;
    for (index, line) in body.lines().enumerate() {
        if line.starts_with("```") || line.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        let bytes = line.as_bytes();
        if bytes.len() >= 5 && matches!(bytes[0], b'-' | b'*' | b'+') && &bytes[1..3] == b" [" && bytes[4] == b']' {
            let checked = match bytes[3] {
                b' ' => false,
                b'x' | b'X' => true,
                _ => continue,
            };
            out.push(Criterion { line: index, checked, text: line[5..].trim().to_owned() });
        }
    }
    out
}

/// Tick or untick the criteria `refs` name. A text matches a criterion exactly
/// (ignoring case), or as the only criterion that contains it.
fn set_criteria(body: &str, refs: &[CriterionRef], checked: bool) -> Result<String> {
    if refs.is_empty() {
        return Ok(body.to_owned());
    }
    let items = criteria(body);
    let listing = || {
        if items.is_empty() {
            "This task has no acceptance criteria.".to_owned()
        } else {
            let lines: Vec<String> = items.iter().enumerate().map(|(i, item)| format!("{}. {}", i + 1, item.text)).collect();
            format!("Its criteria are: {}", lines.join("; "))
        }
    };
    let mut lines: Vec<String> = body.lines().map(str::to_owned).collect();
    for reference in refs {
        let item = match reference {
            CriterionRef::Number(number) => {
                items.get(number.wrapping_sub(1)).ok_or_else(|| anyhow!("There is no criterion {number}. {}", listing()))?
            }
            CriterionRef::Text(text) => {
                let wanted = text.trim().to_lowercase();
                let exact = items.iter().find(|item| item.text.to_lowercase() == wanted);
                match exact {
                    Some(item) => item,
                    None => {
                        let partial: Vec<&Criterion> =
                            items.iter().filter(|item| !wanted.is_empty() && item.text.to_lowercase().contains(&wanted)).collect();
                        match partial.as_slice() {
                            [item] => *item,
                            [] => bail!("No criterion matches {text:?}. {}", listing()),
                            _ => bail!("{text:?} matches more than one criterion; pass its number. {}", listing()),
                        }
                    }
                }
            }
        };
        let line = &mut lines[item.line];
        line.replace_range(3..4, if checked { "x" } else { " " });
    }
    let mut out = lines.join("\n");
    if body.ends_with('\n') {
        out.push('\n');
    }
    Ok(out)
}

/// Add `text` to the description: before a trailing checklist when there is one,
/// so the criteria stay last, else at the end. A blank line separates it.
fn append_before_checklist(body: &str, text: &str) -> String {
    let lines: Vec<&str> = body.lines().collect();
    let items = criteria(body);
    // The trailing checklist starts at the first criterion after which every
    // non-blank line is a criterion or an indented continuation of one.
    let tail_start = items.iter().map(|item| item.line).find(|&start| {
        lines[start..]
            .iter()
            .all(|line| line.trim().is_empty() || line.starts_with("  ") || items.iter().any(|item| lines.get(item.line) == Some(line)))
    });
    match tail_start {
        Some(start) => {
            let head = lines[..start].join("\n");
            let head = head.trim_end();
            let tail = lines[start..].join("\n");
            let mut out = if head.is_empty() { format!("{text}\n\n{tail}") } else { format!("{head}\n\n{text}\n\n{tail}") };
            if body.ends_with('\n') {
                out.push('\n');
            }
            out
        }
        None => {
            let existing = body.trim_end();
            if existing.is_empty() { format!("{text}\n") } else { format!("{existing}\n\n{text}\n") }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn criteria_toggle_by_number_or_text_and_keep_the_rest() {
        let body = "Fix the login.\n\n- [ ] Redirect after sign in\n- [x] Keep the session\n- [ ] Add a test\n";
        let ticked = set_criteria(body, &[CriterionRef::Number(1), CriterionRef::Text("add a TEST".into())], true).unwrap();
        assert_eq!(ticked, "Fix the login.\n\n- [x] Redirect after sign in\n- [x] Keep the session\n- [x] Add a test\n");
        let unticked = set_criteria(&ticked, &[CriterionRef::Text("session".into())], false).unwrap();
        assert!(unticked.contains("- [ ] Keep the session"));
        assert!(set_criteria(body, &[CriterionRef::Number(9)], true).unwrap_err().to_string().contains("no criterion 9"));
        let ambiguous = set_criteria(body, &[CriterionRef::Text("e".into())], true).unwrap_err().to_string();
        assert!(ambiguous.contains("more than one"), "{ambiguous}");
        // A checklist inside a code fence is not a criterion.
        assert!(criteria("```\n- [ ] not me\n```\n- [ ] me").len() == 1);
    }

    #[test]
    fn appended_text_lands_above_the_trailing_checklist() {
        let body = "Fix the login.\n\n- [ ] Redirect\n- [ ] Test\n";
        assert_eq!(
            append_before_checklist(body, "Seen on Safari too."),
            "Fix the login.\n\nSeen on Safari too.\n\n- [ ] Redirect\n- [ ] Test\n"
        );
        assert_eq!(append_before_checklist("Just text", "More"), "Just text\n\nMore\n");
        assert_eq!(append_before_checklist("", "First"), "First\n");
        assert_eq!(append_before_checklist("- [ ] Only items\n", "Context"), "Context\n\n- [ ] Only items\n");
    }
}
