//! Coordinator context rotation: a lead's provider session is replaced by a fresh
//! one inside the same thread, so its live context stays bounded.
//!
//! A rotation starts when a turn ends past the budget, when an idle lead past half
//! of it is released, when the user asks (`coordinator.refresh_context`), or when
//! the Coordinator moves to another harness. The old session first writes a
//! handoff in a Kybern-internal turn ([`InternalTurn`]): its text is collected and
//! nothing reaches the transcript. The daemon checks the handoff against the
//! project, gives it one correction turn, then releases the process and stores a
//! seed (`rotation_seed:{thread}`): the handoff, the facts Kybern tracks, and the
//! last few messages verbatim. The next turn sends the seed in front of its
//! message, in the provider's copy only. Messages sent meanwhile queue.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Result, anyhow, ensure};
use chrono::{DateTime, Utc};
use kybern_drivers::DriverEvent;
use kybern_protocol::methods::{self, TaskStatus};
use kybern_protocol::*;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::change_report::SeenHeads;
use super::{ActiveTurn, LiveSession, Orchestrator, group_git};

/// What the old session is asked to write before it is replaced.
pub(super) const HANDOFF_PROMPT: &str = "[Kybern] Your context is about to be refreshed. Write a handoff for the next session of this
Coordinator. Do not call tools. Use exactly these headings, in this order, and write \"None\" under
a heading with nothing to say. Cite commits as `abc1234`, files as `path`, threads by id.

## Goals
## Decisions (date, what, why, commit if any)
## Reversals and removals (what was undone or deleted, by which thread or commit, and why)
## User preferences (quote the user's words)
## Open questions
## Next steps

Do not restate facts Kybern tracks: child status, pull requests, tasks and git history are
carried separately. Keep it under 1500 words.";

/// The handoff's headings, in order. A heading may carry the prompt's hint after it.
const HANDOFF_HEADINGS: [&str; 6] = ["Goals", "Decisions", "Reversals and removals", "User preferences", "Open questions", "Next steps"];
/// Longest handoff accepted.
const HANDOFF_MAX_BYTES: usize = 16 * 1024;
/// How long the old session has for each handoff turn.
const HANDOFF_TIMEOUT: Duration = Duration::from_secs(90);
/// Most validation errors listed in a correction turn.
const MAX_ERRORS: usize = 20;
/// Exchanges quoted verbatim in the seed, and their size cap.
const RECENT_EXCHANGES: usize = 3;
const RECENT_MAX_BYTES: usize = 12 * 1024;
/// Most children, pull requests or tasks listed per fact line.
const FACT_ITEMS: usize = 15;

pub(super) const ROTATING_STEER_ERROR: &str =
    "Kybern is refreshing this Coordinator's context. Queue your message instead; it is sent when the refresh finishes.";
const BUSY_ERROR: &str = "The Coordinator is busy. Wait for its turn to end, then refresh its context.";

/// Rotations in progress. Their threads queue sends and refuse steering.
pub(super) struct RotationState {
    rotating: std::sync::Mutex<HashSet<ThreadId>>,
    handoff_timeout: std::sync::Mutex<Duration>,
}

impl Default for RotationState {
    fn default() -> Self {
        Self { rotating: Default::default(), handoff_timeout: std::sync::Mutex::new(HANDOFF_TIMEOUT) }
    }
}

/// The output of a Kybern-internal turn: assistant text only.
pub(super) struct InternalTurn {
    messages: Vec<String>,
    partial: String,
    done: Option<tokio::sync::oneshot::Sender<std::result::Result<String, String>>>,
}

impl InternalTurn {
    /// Hand the outcome to the waiting rotation (once).
    pub(super) fn finish(&mut self, outcome: std::result::Result<String, String>) {
        if let Some(done) = self.done.take() {
            let _ = done.send(outcome);
        }
    }

    fn text(&self) -> String {
        if self.messages.is_empty() { self.partial.trim().to_owned() } else { self.messages.join("\n\n") }
    }
}

/// What the event pump does with a driver event of an internal turn. Short-lived
/// (matched right away), so the unboxed `DriverEvent` is fine.
#[allow(clippy::large_enum_variant)]
pub(super) enum InternalEvent {
    /// The turn consumed it.
    Consumed,
    /// The session started work a handoff must not do (a tool on a harness that
    /// cannot hold the lead to read-only tools, or background work): the handoff
    /// already failed, and the waiting rotation interrupts the provider's turn.
    Interrupt,
    /// Handle it outside any turn (session, usage and process state, and
    /// permission requests to deny).
    Pass(DriverEvent),
}

/// Fold one driver event into the internal turn in `turn`.
pub(super) fn internal_turn_event(turn: &mut Option<ActiveTurn>, ev: DriverEvent) -> InternalEvent {
    let Some(active) = turn.as_mut() else { return InternalEvent::Pass(ev) };
    let enforced = super::lead::lead_restrictions_enforced(active.provider);
    let Some(internal) = active.internal.as_mut() else { return InternalEvent::Pass(ev) };
    let mut settled = false;
    let passed = match ev {
        // Read-only built-ins are all a held lead can run, and Kybern's tools refuse
        // internal turns. Elsewhere a tool may edit or run commands nobody would see.
        DriverEvent::ToolStarted(call) if !enforced && call.parent_id.is_none() => {
            internal.finish(Err(format!("The session called {} instead of writing a handoff.", call.name)));
            return InternalEvent::Interrupt;
        }
        // A native subagent or background process would outlive the handoff unseen.
        DriverEvent::RuntimeTaskStarted(task) => {
            internal.finish(Err(format!("The session started background work ({}) instead of writing a handoff.", task.title)));
            return InternalEvent::Interrupt;
        }
        DriverEvent::TextDelta { origin, delta, .. } => {
            if origin.is_root() {
                internal.partial.push_str(&delta);
            }
            None
        }
        DriverEvent::MessageCompleted { origin, text, .. } => {
            if origin.is_root() {
                internal.partial.clear();
                if !text.trim().is_empty() {
                    internal.messages.push(text.trim().to_owned());
                }
            }
            None
        }
        DriverEvent::TurnCompleted { .. } => {
            let text = internal.text();
            internal.finish(Ok(text));
            settled = true;
            None
        }
        DriverEvent::TurnFailed { error } => {
            internal.finish(Err(format!("The handoff turn failed: {error}")));
            settled = true;
            None
        }
        ev @ (DriverEvent::PermissionRequest { .. }
        | DriverEvent::PermissionWithdrawn { .. }
        | DriverEvent::SessionBound { .. }
        | DriverEvent::CommandsUpdated(_)
        | DriverEvent::UsageUpdated(_)
        | DriverEvent::Notice { .. }
        | DriverEvent::Exited { .. }) => Some(ev),
        // Reasoning, tools, background work, images and questions belong to no transcript.
        _ => None,
    };
    if settled {
        *turn = None;
    }
    passed.map_or(InternalEvent::Consumed, InternalEvent::Pass)
}

/// A rotation that has started (`ContextRotationStarted` is in the log).
pub(super) struct Rotation {
    id: String,
    reason: RotationReason,
    thread_id: ThreadId,
    used_tokens: u64,
    live: Option<Arc<LiveSession>>,
}

/// Where a harness-switch rotation moves the Coordinator.
pub(super) struct HarnessSwitch {
    pub provider: ProviderInstance,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: PermissionMode,
}

/// The first provider message of a fresh session, as stored in `rotation_seed:{thread}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(super) struct RotationSeed {
    pub rotation_id: String,
    pub text: String,
    /// Byte range of the handoff section in `text`, replaced when the user edits it.
    handoff: (usize, usize),
}

impl RotationSeed {
    fn replace_handoff(&mut self, section: &str) {
        let (start, end) = self.handoff;
        self.text.replace_range(start..end, section);
        self.handoff = (start, start + section.len());
    }
}

/// The latest handoff edit, kept until a fresh session has read it.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct HandoffEdit {
    rotation_id: String,
    seq: EventSeq,
    text: String,
}

fn seed_key(thread_id: ThreadId) -> String {
    format!("rotation_seed:{thread_id}")
}

fn edit_key(thread_id: ThreadId) -> String {
    format!("handoff_edit:{thread_id}")
}

fn seen_key(thread_id: ThreadId) -> String {
    format!("handoff_seen:{thread_id}")
}

impl Orchestrator {
    /// Whether this thread's context is being refreshed right now.
    pub(super) fn is_rotating(&self, thread_id: ThreadId) -> bool {
        self.inner.rotation.rotating.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).contains(&thread_id)
    }

    #[cfg(test)]
    pub(super) fn set_handoff_timeout(&self, timeout: Duration) {
        *self.inner.rotation.handoff_timeout.lock().unwrap() = timeout;
    }

    fn handoff_timeout(&self) -> Duration {
        *self.inner.rotation.handoff_timeout.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Context used by the thread's current session, and the model's window. The
    /// process's own last report, else the log since the last rotation or harness move.
    fn context_used(&self, thread: &Thread, live: Option<&LiveSession>) -> (u64, Option<u64>) {
        let cached = live.and_then(|live| live.context_usage.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone());
        let context =
            cached.or_else(|| self.inner.store.provider_usage_through(thread.id, EventSeq::MAX).ok().and_then(|usage| usage.context));
        let window = context.as_ref().map(|context| context.window_tokens).filter(|window| *window > 0).or_else(|| {
            let key = format!(
                "model_context:{}:{}:{}",
                thread.provider.kind,
                thread.provider.instance,
                thread.model.as_deref().unwrap_or("default")
            );
            self.inner.store.meta_get(&key).ok().flatten().and_then(|value| value.parse().ok()).filter(|window: &u64| *window > 0)
        });
        (context.map_or(0, |context| context.used_tokens), window)
    }

    /// The size a lead rotates at: its setting, at most half the model's window. 0 is off.
    fn rotation_budget(&self, thread: &Thread, window: Option<u64>) -> u64 {
        let Some(project_id) = thread.coordinator_project_id else { return 0 };
        let overrides = self.inner.store.project_get(project_id).ok().flatten().and_then(|project| project.coordinator);
        let budget = self.inner.settings.get().orchestration.effective_for(overrides.as_ref()).rotation_budget_tokens;
        match window {
            Some(window) if budget > 0 => budget.min(window / 2),
            _ => budget,
        }
    }

    /// After a lead's turn: refresh its context when it passed the budget and
    /// nothing else is waiting for it.
    pub(super) fn rotate_if_over_budget(&self, thread_id: ThreadId, live: Arc<LiveSession>) {
        let this = self.clone();
        tokio::spawn(async move {
            let Ok(Some(thread)) = this.inner.store.thread_get(thread_id) else { return };
            let (used, window) = this.context_used(&thread, Some(&live));
            let budget = this.rotation_budget(&thread, window);
            if budget == 0 || used < budget {
                return;
            }
            if !this.inner.store.queue_list(Some(thread_id)).is_ok_and(|queued| queued.is_empty()) {
                return;
            }
            // A session that starts over the budget (a small window) would refresh
            // after every turn: give each fresh session a second turn first.
            let turns = this.inner.store.events_for_thread(thread_id).map_or(0, |events| {
                events
                    .iter()
                    .rev()
                    .take_while(|event| !matches!(event.payload, EventPayload::ContextRotated { .. }))
                    .filter(|event| matches!(event.payload, EventPayload::TurnStarted { .. }))
                    .count()
            });
            if turns < 2 {
                return;
            }
            match this.begin_rotation(thread_id, RotationReason::Budget, Some(live)).await {
                Ok(rotation) => {
                    if let Err(error) = this.run_rotation(rotation, None).await {
                        tracing::warn!(%thread_id, %error, "the Coordinator's context refresh failed");
                    }
                }
                Err(error) => tracing::debug!(%thread_id, %error, "not refreshing the Coordinator's context now"),
            }
        });
    }

    /// Whether an idle release of this session should be a rotation instead:
    /// a lead past half its budget.
    pub(super) fn idle_rotation_due(&self, thread_id: ThreadId, live: &LiveSession) -> bool {
        let Ok(Some(thread)) = self.inner.store.thread_get(thread_id) else { return false };
        if thread.coordinator_project_id.is_none() || thread.subagent.is_some() || self.is_rotating(thread_id) {
            return false;
        }
        let (used, window) = self.context_used(&thread, Some(live));
        let budget = self.rotation_budget(&thread, window);
        budget > 0 && used > 0 && used >= budget / 2
    }

    /// The idle release of a lead: the handoff is written before the process closes.
    pub(super) fn rotate_idle(&self, thread_id: ThreadId, live: Arc<LiveSession>) {
        let this = self.clone();
        tokio::spawn(async move {
            match this.begin_rotation(thread_id, RotationReason::Idle, Some(live)).await {
                Ok(rotation) => {
                    if let Err(error) = this.run_rotation(rotation, None).await {
                        tracing::warn!(%thread_id, %error, "the Coordinator's idle context refresh failed");
                    }
                }
                Err(error) => tracing::debug!(%thread_id, %error, "not refreshing the idle Coordinator's context"),
            }
        });
    }

    /// `coordinator.refresh_context`: start a refresh of an idle Coordinator now.
    /// It runs in the background; the transcript shows its progress.
    pub async fn coordinator_refresh_context(
        &self,
        params: methods::CoordinatorRefreshContextParams,
    ) -> Result<methods::CoordinatorRefreshContextResult> {
        let rotation = self.begin_rotation(params.thread_id, RotationReason::Manual, None).await?;
        let rotation_id = rotation.id.clone();
        let this = self.clone();
        tokio::spawn(async move {
            let thread_id = rotation.thread_id;
            if let Err(error) = this.run_rotation(rotation, None).await {
                tracing::warn!(%thread_id, %error, "the Coordinator's context refresh failed");
            }
        });
        Ok(methods::CoordinatorRefreshContextResult { rotation_id })
    }

    /// Claim the thread for a rotation and record its start. Refused unless the
    /// lead is idle: no turn, approval or background work, and no other rotation.
    pub(super) async fn begin_rotation(
        &self,
        thread_id: ThreadId,
        reason: RotationReason,
        live: Option<Arc<LiveSession>>,
    ) -> Result<Rotation> {
        let thread =
            self.inner.store.thread_get(thread_id)?.ok_or_else(|| anyhow!("Thread not found. Refresh the thread list and try again."))?;
        ensure!(
            thread.coordinator_project_id.is_some() && thread.subagent.is_none(),
            "Only a project's Coordinator can refresh its context. Open the Coordinator and try again."
        );
        let live = match live {
            Some(live) => Some(live),
            None => self.inner.sessions.lock().await.get(&thread_id).cloned(),
        };
        let background = || anyhow!("The Coordinator has background work running. Wait for it to finish, then refresh its context.");
        if self.inner.store.runtime_tasks_for_thread(thread_id)?.iter().any(|task| task.status.is_active()) {
            return Err(background());
        }
        let (used_tokens, window_tokens) = self.context_used(&thread, live.as_deref());
        let id = Uuid::now_v7().to_string();
        {
            // The turn slot stays locked while the claim is made, so no turn starts in between.
            let turn = match &live {
                Some(live) => Some(live.turn.lock().await),
                None => None,
            };
            if turn.as_ref().is_some_and(|turn| turn.is_some()) {
                return Err(anyhow!(BUSY_ERROR));
            }
            if let Some(live) = &live {
                if live.tasks.lock().await.values().any(|task| task.status.is_active()) {
                    return Err(background());
                }
                if !live.pending.lock().await.is_empty() {
                    return Err(anyhow!(BUSY_ERROR));
                }
            }
            let _command = self.inner.commands.lock().map_err(|_| anyhow!("command lock poisoned"))?;
            let current = self.inner.store.thread_get(thread_id)?.ok_or_else(|| anyhow!("Thread not found."))?;
            ensure!(matches!(current.status, ThreadStatus::Idle | ThreadStatus::Failed), BUSY_ERROR);
            {
                let mut rotating = self.inner.rotation.rotating.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                ensure!(rotating.insert(thread_id), "The Coordinator's context is already being refreshed. Wait for it to finish.");
            }
            if let Err(error) = self.emit(
                thread_id,
                None,
                EventPayload::ContextRotationStarted { rotation_id: id.clone(), reason, used_tokens, window_tokens },
            ) {
                self.inner.rotation.rotating.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(&thread_id);
                return Err(error);
            }
        }
        tracing::info!(%thread_id, rotation_id = %id, reason = reason.as_str(), used_tokens, "refreshing the Coordinator's context");
        Ok(Rotation { id, reason, thread_id, used_tokens, live })
    }

    /// Write the handoff, release the old session, store the seed and record the
    /// outcome. Always ends the rotation, and wakes the queue for what waited.
    pub(super) async fn run_rotation(&self, rotation: Rotation, switch: Option<HarnessSwitch>) -> Result<Thread> {
        let mut released = false;
        let result = self.rotate(&rotation, switch, &mut released).await;
        if let Err(error) = &result {
            // Close the pending row. Before the release the old session carries on,
            // so the context it reported stays (`session_kept`).
            let current = self.inner.store.thread_get(rotation.thread_id).ok().flatten();
            let harness = current.map(|thread| HarnessRef { kind: thread.provider.kind, model: thread.model });
            if let Some(harness) = harness {
                let _ = self.emit(
                    rotation.thread_id,
                    None,
                    EventPayload::ContextRotated {
                        rotation_id: rotation.id.clone(),
                        reason: rotation.reason,
                        handoff: None,
                        handoff_status: HandoffStatus::Missing { why: format!("Kybern could not refresh the context: {error}") },
                        carried: RotationCarried::default(),
                        from: harness.clone(),
                        to: harness,
                        session_kept: !released,
                    },
                );
            }
        }
        self.inner.rotation.rotating.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(&rotation.thread_id);
        self.inner.queue_wakeup.notify_one();
        result
    }

    /// `released` turns true once the old session is gone.
    async fn rotate(&self, rotation: &Rotation, switch: Option<HarnessSwitch>, released: &mut bool) -> Result<Thread> {
        let thread = self.inner.store.thread_get(rotation.thread_id)?.ok_or_else(|| anyhow!("The Coordinator thread was not found."))?;
        let from = HarnessRef { kind: thread.provider.kind, model: thread.model.clone() };
        let (handoff, handoff_status) = self.write_handoff(&thread, rotation, switch.is_some()).await;
        let thread = self.release_for_rotation(rotation.thread_id, switch).await?;
        *released = true;
        let to = HarnessRef { kind: thread.provider.kind, model: thread.model.clone() };
        let (carried, seed) = self.build_seed(&thread, rotation, handoff.as_deref(), &handoff_status, &to).await?;
        let seed_json = serde_json::to_string(&seed)?;
        self.inner.store.meta_set_many(&[
            (&seed_key(thread.id), &seed_json),
            (&edit_key(thread.id), ""),
            (&seen_key(thread.id), ""),
            // A fresh session needs no portable delta of the conversation; the seed carries it.
            (&format!("handoff:{}", thread.id), ""),
        ])?;
        self.emit(
            thread.id,
            None,
            EventPayload::ContextRotated {
                rotation_id: rotation.id.clone(),
                reason: rotation.reason,
                handoff,
                handoff_status,
                carried,
                from,
                to,
                session_kept: false,
            },
        )?;
        Ok(self.inner.store.thread_get(thread.id)?.unwrap_or(thread))
    }

    /// The old session's handoff, checked, with one correction; or why there is none.
    async fn write_handoff(&self, thread: &Thread, rotation: &Rotation, switching: bool) -> (Option<String>, HandoffStatus) {
        let missing = |why: String| (None, HandoffStatus::Missing { why });
        if switching && self.ensure_account_signed_in(&thread.provider).is_err() {
            return missing("The previous harness is signed out.".into());
        }
        let current = match rotation.live.clone() {
            Some(live) => Some(live),
            None => self.inner.sessions.lock().await.get(&thread.id).cloned(),
        };
        let live = match current.filter(|live| !live.is_released()) {
            Some(live) => live,
            None => {
                if thread.provider_session_id.is_none() {
                    return missing("The session had no conversation to hand off.".into());
                }
                match self.ensure_session(thread).await {
                    Ok((live, _)) => live,
                    Err(error) => return missing(format!("The previous session could not be resumed: {error}")),
                }
            }
        };
        let text = match self.internal_turn(&live, thread.provider.kind, HANDOFF_PROMPT).await {
            Ok(text) => text,
            Err(why) => return missing(why),
        };
        let errors = self.validate_handoff(thread, &text).await;
        if errors.is_empty() {
            return (Some(handoff_body(&text)), HandoffStatus::Written);
        }
        let text = match self.internal_turn(&live, thread.provider.kind, &correction_prompt(&errors)).await {
            Ok(text) => text,
            Err(why) => return missing(why),
        };
        let errors = self.validate_handoff(thread, &text).await;
        match errors.first() {
            None => (Some(handoff_body(&text)), HandoffStatus::Written),
            Some(first) => missing(format!("The handoff did not pass validation: {first}")),
        }
    }

    /// Send `prompt` as a Kybern-internal turn and wait for its assistant text.
    async fn internal_turn(&self, live: &Arc<LiveSession>, provider: ProviderKind, prompt: &str) -> std::result::Result<String, String> {
        let (done, outcome) = tokio::sync::oneshot::channel();
        let id = Uuid::now_v7();
        {
            let mut turn = live.turn.lock().await;
            if turn.is_some() {
                return Err("The session was busy.".into());
            }
            // A settled Claude turn must not be resumed into the handoff.
            live.continuation.lock().await.take();
            let now = std::time::Instant::now();
            *turn = Some(ActiveTurn {
                id,
                response_id: Uuid::now_v7(),
                started: now,
                startup_started: now,
                provider,
                session_reused: true,
                first_event_observed: false,
                messages: HashMap::new(),
                active_messages: HashMap::new(),
                terminal_message_id: None,
                completed: false,
                pending_completion: None,
                internal: Some(InternalTurn { messages: Vec::new(), partial: String::new(), done: Some(done) }),
                rotation_seed: None,
            });
        }
        live.touch();
        let sent = live.session.send_message(&Uuid::now_v7().to_string(), &UserMessage::text(prompt)).await;
        let result = match sent {
            Err(error) => Err(format!("The handoff request could not be sent: {error}")),
            Ok(()) => match tokio::time::timeout(self.handoff_timeout(), outcome).await {
                Ok(Ok(outcome)) => outcome,
                Ok(Err(_)) => Err("The session closed before it wrote a handoff.".into()),
                Err(_) => Err(format!("The session did not write a handoff within {} seconds.", self.handoff_timeout().as_secs())),
            },
        };
        if result.is_err() && !live.is_released() {
            // Whatever the provider is still doing for this turn stops before the session is released.
            let _ = live.session.interrupt().await;
        }
        let mut turn = live.turn.lock().await;
        if turn.as_ref().is_some_and(|turn| turn.id == id) {
            *turn = None;
        }
        result
    }

    /// Everything wrong with a handoff, each naming its line.
    async fn validate_handoff(&self, thread: &Thread, text: &str) -> Vec<String> {
        let mut errors = Vec::new();
        if text.len() > HANDOFF_MAX_BYTES {
            errors.push(format!("The handoff is {} KiB. Keep it under 16 KiB.", text.len().div_ceil(1024)));
        }
        let mut previous = 0;
        for heading in HANDOFF_HEADINGS {
            match heading_line(text, heading) {
                None => errors.push(format!("The heading \"## {heading}\" is missing.")),
                Some(line) if line < previous => errors.push(format!("Line {line}: \"## {heading}\" is out of order.")),
                Some(line) => previous = line,
            }
        }
        let repos = GitRepos::for_thread(thread, self.last_rotation_at(thread)).await;
        for (index, line) in text.lines().enumerate() {
            let number = index + 1;
            for token in backticked(line) {
                let (path, sha) = match token.rsplit_once('@') {
                    Some((path, sha)) if is_sha(sha) => (Some(path), Some(sha)),
                    _ if is_sha(token) => (None, Some(token)),
                    _ => (Some(token), None),
                };
                if let Some(sha) = sha
                    && !repos.is_empty()
                    && !repos.has_commit(sha).await
                {
                    errors.push(format!("Line {number}: `{sha}` is not a commit in this project."));
                }
                if let Some(path) = path.filter(|path| looks_like_path(path))
                    && !repos.is_empty()
                    && !repos.knows_path(path).await
                {
                    errors.push(format!("Line {number}: `{path}` is not a file in this project, and was not deleted or renamed recently."));
                }
            }
            for id in uuids(line) {
                if !self.id_known(id) {
                    errors.push(format!("Line {number}: {id} is not a thread Kybern knows."));
                }
            }
        }
        errors.dedup();
        errors.truncate(MAX_ERRORS);
        errors
    }

    /// Whether `id` names a thread (or a delegation, note or task an agent may cite).
    fn id_known(&self, id: Uuid) -> bool {
        let store = &self.inner.store;
        store.thread_get(id).ok().flatten().is_some()
            || store.delegation_find_by_task(id).ok().flatten().is_some()
            || store.note_get(id).ok().flatten().is_some()
            || store.task_item_get(id).ok().flatten().is_some()
    }

    /// When the latest finished rotation of this thread happened.
    fn last_rotation_at(&self, thread: &Thread) -> DateTime<Utc> {
        self.inner.store.latest_event_of_kinds(thread.id, &["context_rotated"]).ok().flatten().map_or(thread.created_at, |event| event.at)
    }

    /// Close the old process (as a harness switch always did) and clear the
    /// native session, so the next message starts a fresh one. A switch also
    /// moves the thread to its new harness.
    async fn release_for_rotation(&self, thread_id: ThreadId, switch: Option<HarnessSwitch>) -> Result<Thread> {
        let (thread, released) = {
            let mut sessions = self.inner.sessions.lock().await;
            let mut releasing = self.inner.releasing.lock().await;
            let _command = self.inner.commands.lock().map_err(|_| anyhow!("command lock poisoned"))?;
            let mut thread = self.inner.store.thread_get(thread_id)?.ok_or_else(|| anyhow!("The Coordinator thread was not found."))?;
            let released = sessions.remove(&thread_id);
            let switched = switch.is_some();
            let previous = (switched && thread.provider_session_id.is_some()).then(|| thread.clone());
            if let Some(switch) = switch {
                thread.provider = switch.provider;
                thread.model = switch.model;
                thread.effort = switch.effort;
                thread.permission_mode = switch.permission_mode;
                thread.status = ThreadStatus::Idle;
            }
            thread.provider_session_id = None;
            let thread = match self.update_thread(thread) {
                Ok(thread) => thread,
                Err(error) => {
                    if let Some(live) = released {
                        sessions.insert(thread_id, live);
                    }
                    return Err(error);
                }
            };
            let released = released.map(|live| {
                live.mark_released();
                self.revoke_native_session(&live);
                let (done, waiting) = tokio::sync::watch::channel(());
                releasing.insert(thread_id, waiting);
                (live, done)
            });
            if let Some(mut previous) = previous {
                // Switching back later must not resume the replaced conversation.
                previous.provider_session_id = None;
                if let Err(error) = self.save_account_binding(&previous) {
                    tracing::warn!(%thread_id, %error, "could not clear the previous harness's session binding");
                }
            }
            if switched {
                // A target chosen on the old harness would move the thread back at the next send.
                let current =
                    SessionTarget { provider: thread.provider.clone(), model: thread.model.clone(), effort: thread.effort.clone() };
                if self.stored_target(&thread)?.is_some_and(|stored| stored != current) {
                    self.inner.store.meta_set(&format!("target:{thread_id}"), &serde_json::to_string(&current)?)?;
                }
                // Messages queued for the old harness (sent while this refresh ran) start the fresh session on the new one.
                if let Err(error) = self.retarget_queue(&thread) {
                    tracing::warn!(%thread_id, %error, "could not move the queued messages to the new harness");
                }
            }
            (thread, released)
        };
        self.inner.pending_rewinds.lock().await.remove(&thread_id);
        // The old conversation must never be resumed again for this provider.
        if let Err(error) = self.save_account_binding(&thread) {
            tracing::warn!(%thread_id, %error, "could not clear the replaced session's binding");
        }
        if let Some((live, done)) = released {
            let close = live.session.close().await;
            self.inner.releasing.lock().await.remove(&thread_id);
            drop(done);
            if let Err(error) = close {
                tracing::warn!(%thread_id, %error, "the replaced agent process did not close cleanly");
            }
        }
        Ok(thread)
    }

    /// Point every queued message of `thread` at its current harness and permission mode.
    fn retarget_queue(&self, thread: &Thread) -> Result<()> {
        let queued = self.inner.store.queue_list(Some(thread.id))?;
        if queued.is_empty() {
            return Ok(());
        }
        let target = self.thread_target(thread.id)?.target;
        let mode = self.pending_permission_for(thread, &target.provider)?.unwrap_or(thread.permission_mode);
        let (target, mode) = (serde_json::to_string(&target)?, serde_json::to_string(&mode)?);
        let keys: Vec<(String, String)> = queued
            .iter()
            .flat_map(|message| {
                [(format!("queue_target:{}", message.id), target.clone()), (format!("queue_permission:{}", message.id), mode.clone())]
            })
            .collect();
        let rows: Vec<(&str, &str)> = keys.iter().map(|(key, value)| (key.as_str(), value.as_str())).collect();
        self.inner.store.meta_set_many(&rows)
    }

    /// The seed and the counts of what it carries.
    async fn build_seed(
        &self,
        thread: &Thread,
        rotation: &Rotation,
        handoff: Option<&str>,
        status: &HandoffStatus,
        to: &HarnessRef,
    ) -> Result<(RotationCarried, RotationSeed)> {
        let since = self.last_rotation_at(thread);
        let mut carried = RotationCarried { head: rotation_heads(thread).await, ..Default::default() };
        let events = self.inner.store.events_for_thread(thread.id)?;
        let entries = kybern_store::project_transcript(&events);
        let (recent, first_seq) = recent_exchanges(&entries);

        let as_of = match carried.head.as_slice() {
            [] => Utc::now().format("%Y-%m-%d %H:%M UTC").to_string(),
            [head] => format!("`{}`", short(&head.sha)),
            heads => heads.iter().map(|head| format!("{}@`{}`", head.repo, short(&head.sha))).collect::<Vec<_>>().join(", "),
        };
        let reason = match rotation.reason {
            RotationReason::Budget => format!("it used {} tokens", tokens_label(rotation.used_tokens)),
            RotationReason::Idle => "the session was idle".to_owned(),
            RotationReason::Manual => "the user asked for it".to_owned(),
            RotationReason::HarnessSwitch => {
                format!(
                    "the Coordinator moved to {}{}",
                    to.kind.display_name(),
                    to.model.as_deref().map(|m| format!(" ({m})")).unwrap_or_default()
                )
            }
        };
        let first_seq = first_seq.unwrap_or(thread.last_seq + 1);
        let mut text = format!(
            "[Kybern] This is a fresh session for this project's Coordinator. The previous session's context\n\
             was refreshed ({reason}). Before you answer, read the handoff and facts below. Treat the handoff\n\
             as claims as of {as_of}: check the current code before you rely on anything it says about code.\n\
             Older history: kybern_thread_read on this thread (seq < {first_seq}), or kybern_threads_search.\n\n"
        );
        let section = handoff_section(handoff, status, false);
        let start = text.len();
        text.push_str(&section);
        let handoff_range = (start, text.len());

        text.push_str("\n\n## Facts (from Kybern, not summarized)\n");
        text.push_str(&self.children_facts(thread, since, &mut carried)?);
        text.push_str(&pull_request_facts(&events, &mut carried));
        text.push_str(&self.task_facts(thread, &mut carried)?);
        match self.seed_git_section(thread).await {
            Some(git) => {
                carried.commits = git.lines().filter(|line| is_commit_line(line)).count() as u32;
                text.push_str("- Git since the last refresh:\n");
                for line in git.lines() {
                    text.push_str(&format!("  {line}\n"));
                }
            }
            None => text.push_str("- Git since the last refresh: no new commits Kybern can see; use kybern_git for history.\n"),
        }
        if let Some(map) = self.seed_map_header(thread.project_id).await {
            text.push_str("- Map:\n");
            for line in map.lines() {
                text.push_str(&format!("  {line}\n"));
            }
        }
        text.push_str("\n## Recent messages (verbatim)\n");
        text.push_str(if recent.is_empty() { "(None yet.)" } else { &recent });
        Ok((carried, RotationSeed { rotation_id: rotation.id.clone(), text, handoff: handoff_range }))
    }

    /// The git changes since the heads recorded at the last refresh (or, before the
    /// first one, since the Coordinator's last change report). Records the current
    /// heads for the next refresh and marks them seen, so the next change report
    /// doesn't repeat what the seed already carried.
    async fn seed_git_section(&self, thread: &Thread) -> Option<String> {
        let key = rotation_heads_key(thread.id);
        let stored: Option<SeenHeads> = self.inner.store.meta_get(&key).ok().flatten().and_then(|json| serde_json::from_str(&json).ok());
        let since = match stored {
            Some(heads) => heads,
            None => self.lead_seen_heads(thread).await.unwrap_or_default(),
        };
        let delta = self.git_delta_since(thread, &since).await;
        let now = self.lead_git_heads(thread).await;
        if !now.is_empty() {
            if let Ok(json) = serde_json::to_string(&now)
                && let Err(error) = self.inner.store.meta_set(&key, &json)
            {
                tracing::warn!(thread_id = %thread.id, %error, "could not record the heads at this refresh");
            }
            if let Err(error) = self.lead_git_mark_seen(thread, &now) {
                tracing::warn!(thread_id = %thread.id, %error, "could not mark the refreshed heads seen");
            }
        }
        delta
    }

    /// The project map header for the HEADs the seed reports, rebuilt when they
    /// moved since the old session started, fenced as repository data.
    async fn seed_map_header(&self, project_id: ProjectId) -> Option<String> {
        self.fresh_map_header(project_id).await.map(|header| super::project_map::fence_map(&header))
    }

    fn children_facts(&self, thread: &Thread, since: DateTime<Utc>, carried: &mut RotationCarried) -> Result<String> {
        let children = self.inner.store.delegation_children(thread.id)?;
        let mut running = Vec::new();
        let mut finished = Vec::new();
        for child in &children {
            let Some(info) = &child.delegation else { continue };
            let harness = child.provider.kind.display_name();
            let branch = info.branch.as_deref().map(|branch| format!(", branch `{branch}`")).unwrap_or_default();
            if info.status == DelegationStatus::Running {
                running.push(format!("  - {} ({harness}, {}{branch}, thread {})\n", child.title, info.status.as_str(), child.id));
            } else if info.completed_at.is_some_and(|at| at >= since) {
                let commit = info.head_commit.as_deref().map(|sha| format!(", commit `{}`", short(sha))).unwrap_or_default();
                finished.push(format!("  - {} ({}{commit}, thread {})\n", child.title, info.status.as_str(), child.id));
            }
        }
        carried.children = (running.len() + finished.len()) as u32;
        let mut out = String::new();
        list_fact(&mut out, "Children running", "none", running);
        list_fact(&mut out, "Children finished since the last refresh", "none", finished);
        Ok(out)
    }

    fn task_facts(&self, thread: &Thread, carried: &mut RotationCarried) -> Result<String> {
        let mut family: HashSet<ThreadId> = self.delegation_descendants(thread.id)?.into_iter().map(|child| child.id).collect();
        family.insert(thread.id);
        let lines: Vec<String> = self
            .inner
            .store
            .task_items_list()?
            .into_iter()
            .filter(|task| !matches!(task.status, TaskStatus::Done | TaskStatus::Canceled))
            .filter(|task| {
                task.created_by_thread.is_some_and(|id| family.contains(&id)) || task.runs.iter().any(|run| family.contains(&run.thread_id))
            })
            .map(|task| format!("  - {} {} ({}, id {})\n", task.key, task.title, task.status.as_str(), task.id))
            .collect();
        carried.tasks = lines.len() as u32;
        let mut out = String::new();
        list_fact(&mut out, "Tasks", "none open", lines);
        Ok(out)
    }

    /// The seed the next turn of this thread must carry, if a rotation left one.
    pub(super) fn rotation_seed(&self, thread_id: ThreadId) -> Result<Option<RotationSeed>> {
        let Some(saved) = self.inner.store.meta_get(&seed_key(thread_id))?.filter(|saved| !saved.is_empty()) else { return Ok(None) };
        Ok(Some(serde_json::from_str(&saved)?))
    }

    /// The fresh session received `sent`. An edit that landed while it was being
    /// sent is delivered once more, as a correction.
    pub(super) fn rotation_seed_sent(&self, thread_id: ThreadId, sent: &RotationSeed) -> Result<()> {
        let _command = self.inner.commands.lock().map_err(|_| anyhow!("command lock poisoned"))?;
        let Some(current) = self.rotation_seed(thread_id)? else { return Ok(()) };
        if current.rotation_id != sent.rotation_id {
            return Ok(());
        }
        if current.text != sent.text {
            self.inner.store.meta_set(&seen_key(thread_id), "0")?;
        }
        self.inner.store.meta_set(&seed_key(thread_id), "")
    }

    /// For a session that already read its seed: the user's correction of the
    /// handoff, once, with the edit's sequence to remember after it is sent.
    pub(super) fn handoff_correction(&self, thread: &Thread) -> Result<Option<(EventSeq, String)>> {
        let Some(saved) = self.inner.store.meta_get(&edit_key(thread.id))?.filter(|saved| !saved.is_empty()) else { return Ok(None) };
        let edit: HandoffEdit = serde_json::from_str(&saved)?;
        if self.rotation_seed(thread.id)?.is_some_and(|seed| seed.rotation_id == edit.rotation_id) {
            return Ok(None);
        }
        let seen = self.inner.store.meta_get(&seen_key(thread.id))?.and_then(|seen| seen.parse::<EventSeq>().ok()).unwrap_or(0);
        Ok((edit.seq > seen).then(|| (edit.seq, format!("Handoff corrected by the user:\n{}", edit.text))))
    }

    pub(super) fn handoff_correction_seen(&self, thread_id: ThreadId, seq: EventSeq) -> Result<()> {
        self.inner.store.meta_set(&seen_key(thread_id), &seq.to_string())
    }

    /// `coordinator.edit_handoff`: replace the latest rotation's handoff.
    pub async fn coordinator_edit_handoff(&self, params: methods::CoordinatorEditHandoffParams) -> Result<()> {
        let thread = self
            .inner
            .store
            .thread_get(params.thread_id)?
            .ok_or_else(|| anyhow!("Thread not found. Refresh the thread list and try again."))?;
        ensure!(thread.coordinator_project_id.is_some(), "Only a Coordinator has a handoff to edit. Open the Coordinator and try again.");
        ensure!(!self.is_rotating(thread.id), "Wait for the context refresh to finish, then edit its handoff.");
        let text = params.text.trim().to_owned();
        ensure!(!text.is_empty(), "Write the handoff text, then save again.");
        ensure!(text.len() <= HANDOFF_MAX_BYTES, "The handoff is longer than 16 KiB. Shorten it and save again.");
        let latest = self.inner.store.events_for_thread(thread.id)?.iter().rev().find_map(|event| match &event.payload {
            EventPayload::ContextRotated { rotation_id, .. } => Some(rotation_id.clone()),
            _ => None,
        });
        ensure!(
            latest.as_deref() == Some(params.rotation_id.as_str()),
            "Only the latest context refresh's handoff can be edited. Reload the thread and edit that one."
        );
        let _command = self.inner.commands.lock().map_err(|_| anyhow!("command lock poisoned"))?;
        let event =
            self.emit(thread.id, None, EventPayload::HandoffEdited { rotation_id: params.rotation_id.clone(), text: text.clone() })?;
        let edit = HandoffEdit { rotation_id: params.rotation_id.clone(), seq: event.seq, text: text.clone() };
        self.inner.store.meta_set(&edit_key(thread.id), &serde_json::to_string(&edit)?)?;
        if let Some(mut seed) = self.rotation_seed(thread.id)?
            && seed.rotation_id == params.rotation_id
        {
            // Not sent yet: the fresh session reads the edited handoff in its seed.
            seed.replace_handoff(&handoff_section(Some(&text), &HandoffStatus::Written, true));
            self.inner
                .store
                .meta_set_many(&[(&seed_key(thread.id), &serde_json::to_string(&seed)?), (&seen_key(thread.id), &event.seq.to_string())])?;
        }
        Ok(())
    }

    /// A rotation cut off by a restart never wrote its handoff: finish it without one.
    /// One thread that cannot be recovered does not hold up the others.
    pub(super) async fn rotation_recover_after_restart(&self) -> Result<()> {
        for thread in self.inner.store.threads_list(None, true)? {
            if thread.coordinator_project_id.is_none() || thread.status == ThreadStatus::Archived {
                continue;
            }
            let thread_id = thread.id;
            if let Err(error) = self.rotation_recover_thread(thread).await {
                tracing::warn!(%thread_id, %error, "could not finish a context refresh cut off by the restart");
            }
        }
        Ok(())
    }

    async fn rotation_recover_thread(&self, thread: Thread) -> Result<()> {
        let latest = self.inner.store.latest_event_of_kinds(thread.id, &["context_rotation_started", "context_rotated"])?;
        let Some(EventPayload::ContextRotationStarted { rotation_id, reason, used_tokens, .. }) = latest.map(|event| event.payload) else {
            return Ok(());
        };
        let rotation = Rotation { id: rotation_id, reason, thread_id: thread.id, used_tokens, live: None };
        let from = HarnessRef { kind: thread.provider.kind, model: thread.model.clone() };
        let thread = self.release_for_rotation(thread.id, None).await?;
        let status = HandoffStatus::Missing { why: "Kybern restarted before the handoff was written.".into() };
        let (carried, seed) = self.build_seed(&thread, &rotation, None, &status, &from).await?;
        self.inner.store.meta_set_many(&[
            (&seed_key(thread.id), &serde_json::to_string(&seed)?),
            (&edit_key(thread.id), ""),
            (&seen_key(thread.id), ""),
            (&format!("handoff:{}", thread.id), ""),
        ])?;
        self.emit(
            thread.id,
            None,
            EventPayload::ContextRotated {
                rotation_id: rotation.id,
                reason,
                handoff: None,
                handoff_status: status,
                carried,
                from: from.clone(),
                to: from,
                session_kept: false,
            },
        )?;
        Ok(())
    }
}

/// The handoff section of a seed.
fn handoff_section(handoff: Option<&str>, status: &HandoffStatus, edited: bool) -> String {
    let by = if edited { "written by the previous session, edited by the user" } else { "written by the previous session" };
    let body = match (handoff, status) {
        (Some(text), _) => text.trim().to_owned(),
        (None, HandoffStatus::Missing { why }) => {
            format!("No handoff: {}. Rely on the facts and recent messages below.", why.trim().trim_end_matches('.'))
        }
        (None, HandoffStatus::Written) => "No handoff. Rely on the facts and recent messages below.".to_owned(),
    };
    format!("## Handoff ({by})\n{body}")
}

/// What the old session is told when its handoff has problems.
fn correction_prompt(errors: &[String]) -> String {
    let mut out = String::from(
        "[Kybern] Your handoff has problems. Write the whole handoff again with the same six headings and fix them. \
         Do not call tools. If you cannot check a citation, leave it out.\n",
    );
    for error in errors {
        out.push_str(&format!("- {error}\n"));
    }
    out
}

/// The handoff from its first heading on: a preamble before it is dropped.
fn handoff_body(text: &str) -> String {
    let start =
        heading_line(text, HANDOFF_HEADINGS[0]).map_or(0, |line| text.split_inclusive('\n').take(line - 1).map(str::len).sum::<usize>());
    text[start..].trim().to_owned()
}

/// The 1-based line of `## {name}` (with any hint after the name), if present.
fn heading_line(text: &str, name: &str) -> Option<usize> {
    text.lines()
        .position(|line| {
            line.trim_start().strip_prefix("## ").map(str::trim_start).is_some_and(|rest| {
                rest.len() >= name.len() && rest.is_char_boundary(name.len()) && rest[..name.len()].eq_ignore_ascii_case(name)
            })
        })
        .map(|index| index + 1)
}

/// Code spans on one line.
fn backticked(line: &str) -> impl Iterator<Item = &str> {
    line.split('`').skip(1).step_by(2).map(str::trim).filter(|token| !token.is_empty())
}

/// A 7 to 40 character hex token.
fn is_sha(token: &str) -> bool {
    (7..=40).contains(&token.len()) && token.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// File extensions that make a slash-free code span a file name.
const FILE_EXTENSIONS: &[&str] = &[
    "rs", "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "toml", "yaml", "yml", "md", "mdx", "txt", "py", "go", "java", "kt", "swift",
    "rb", "sh", "css", "scss", "html", "lock", "sql", "c", "h", "cpp", "hpp", "cs", "vue", "svelte", "xml", "gradle", "plist", "snap",
];

/// Whether a code span names a project path: something with a slash, or a file
/// name with a known extension. Commands, globs, URLs and absolute paths are not.
fn looks_like_path(token: &str) -> bool {
    if token.is_empty()
        || token.len() > 300
        || token.starts_with(['-', '/', '~', '$'])
        || token.contains("://")
        || token.contains("::")
        || token.chars().any(|c| c.is_whitespace() || "*?()[]{}<>=;,\"'|&!#".contains(c))
    {
        return false;
    }
    if token.contains('/') {
        return true;
    }
    token.rsplit_once('.').is_some_and(|(stem, ext)| !stem.is_empty() && FILE_EXTENSIONS.contains(&ext))
}

/// Hyphenated UUIDs on one line.
fn uuids(line: &str) -> Vec<Uuid> {
    line.split(|c: char| !(c.is_ascii_hexdigit() || c == '-'))
        .filter(|word| word.len() == 36)
        .filter_map(|word| Uuid::parse_str(word).ok())
        .collect()
}

fn short(sha: &str) -> &str {
    &sha[..sha.len().min(7)]
}

fn tokens_label(tokens: u64) -> String {
    if tokens >= 1000 { format!("{}k", tokens / 1000) } else { tokens.to_string() }
}

/// A fact line with nested items, or `- {label}: {empty}.`.
fn list_fact(out: &mut String, label: &str, empty: &str, mut items: Vec<String>) {
    if items.is_empty() {
        out.push_str(&format!("- {label}: {empty}.\n"));
        return;
    }
    let more = items.len().saturating_sub(FACT_ITEMS);
    items.truncate(FACT_ITEMS);
    out.push_str(&format!("- {label}:\n"));
    for item in items {
        out.push_str(&item);
    }
    if more > 0 {
        out.push_str(&format!("  - +{more} more\n"));
    }
}

/// HEAD of each of the thread's repositories.
async fn rotation_heads(thread: &Thread) -> Vec<RepoHead> {
    let mut heads = Vec::new();
    for target in group_git::targets(thread) {
        if !target.dir.join(".git").exists() {
            continue;
        }
        let repo = kybern_git::Repo::new(&target.dir);
        let Some(sha) = repo.head().await else { continue };
        let name = if target.name.is_empty() {
            target.dir.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default()
        } else {
            target.name.clone()
        };
        heads.push(RepoHead { repo: name, branch: repo.current_branch().await, sha });
    }
    heads
}

/// The pull requests this lead opened with `kybern_git` and has not merged.
fn pull_request_facts(events: &[ThreadEvent], carried: &mut RotationCarried) -> String {
    let mut git_calls = HashSet::new();
    let mut open: Vec<(u64, String)> = Vec::new();
    for event in events {
        match &event.payload {
            EventPayload::ToolCallStarted { call, .. } if call.name.ends_with("kybern_git") => {
                git_calls.insert(call.id.clone());
            }
            EventPayload::ToolCallCompleted { tool_call_id, output, is_error: false, .. } if git_calls.contains(tool_call_id) => {
                let Some(value) = tool_json(output) else { continue };
                let Some(number) = value.get("number").and_then(serde_json::Value::as_u64) else { continue };
                open.retain(|(known, _)| *known != number);
                if value.get("status").and_then(serde_json::Value::as_str) != Some("merged") {
                    let title = value.get("title").and_then(serde_json::Value::as_str).unwrap_or("");
                    let url = value.get("url").and_then(serde_json::Value::as_str).unwrap_or("");
                    open.push((number, format!("  - #{number} {title} (open) {url}").trim_end().to_owned() + "\n"));
                }
            }
            _ => {}
        }
    }
    carried.pull_requests = open.len() as u32;
    let mut out = String::new();
    list_fact(&mut out, "Pull requests", "none open", open.into_iter().map(|(_, line)| line).collect());
    out
}

/// A tool result as JSON, whichever way the harness wrapped it.
fn tool_json(output: &serde_json::Value) -> Option<serde_json::Value> {
    match output {
        serde_json::Value::Object(object) if object.contains_key("number") => Some(output.clone()),
        serde_json::Value::Object(object) => object.get("content").and_then(tool_json),
        serde_json::Value::String(text) => serde_json::from_str(text).ok(),
        serde_json::Value::Array(items) => items.iter().find_map(|item| item.get("text").and_then(tool_json)),
        _ => None,
    }
}

/// Who wrote a user-side message, for the seed's attribution.
fn speaker(message: &UserMessage) -> String {
    for part in &message.parts {
        match part {
            ContentPart::AgentResults { .. } => return "Agent results".into(),
            ContentPart::ThreadMessage { from_title, .. } => return format!("Message from {from_title}"),
            _ => {}
        }
    }
    "User".into()
}

struct Exchange {
    turn_id: TurnId,
    users: Vec<(EventSeq, String, String)>,
    /// Root assistant messages: id, first sequence, text.
    replies: Vec<(MessageId, EventSeq, String)>,
    terminal: Option<MessageId>,
}

/// The last few exchanges, final text only, oldest first, and the first sequence they cover.
fn recent_exchanges(entries: &[TranscriptEntry]) -> (String, Option<EventSeq>) {
    let mut exchanges: Vec<Exchange> = Vec::new();
    let exchange = |exchanges: &mut Vec<Exchange>, turn_id: TurnId| -> usize {
        if let Some(index) = exchanges.iter().rposition(|exchange| exchange.turn_id == turn_id) {
            return index;
        }
        exchanges.push(Exchange { turn_id, users: Vec::new(), replies: Vec::new(), terminal: None });
        exchanges.len() - 1
    };
    for entry in entries {
        match entry {
            TranscriptEntry::User { turn_id, seq, message, .. } => {
                let index = exchange(&mut exchanges, *turn_id);
                exchanges[index].users.push((*seq, speaker(message), message.plain_text()));
            }
            TranscriptEntry::Assistant { id, turn_id, seq, origin: EventOrigin::Root, text, .. } if !text.trim().is_empty() => {
                let index = exchange(&mut exchanges, *turn_id);
                let replies = &mut exchanges[index].replies;
                match replies.iter_mut().find(|(reply, ..)| reply == id) {
                    Some((_, _, existing)) => existing.push_str(text),
                    None => replies.push((*id, *seq, text.clone())),
                }
            }
            TranscriptEntry::TurnSummary { turn_id, terminal_message_id, .. } => {
                let index = exchange(&mut exchanges, *turn_id);
                exchanges[index].terminal = *terminal_message_id;
            }
            _ => {}
        }
    }
    let mut blocks: Vec<(EventSeq, String)> = exchanges
        .iter()
        .filter(|exchange| !exchange.users.is_empty())
        .map(|exchange| {
            let mut block = String::new();
            for (seq, who, text) in &exchange.users {
                block.push_str(&format!("[{who} · seq {seq}]\n{}\n\n", text.trim()));
            }
            let reply =
                exchange.terminal.and_then(|terminal| exchange.replies.iter().find(|(id, ..)| *id == terminal)).or(exchange.replies.last());
            if let Some((_, seq, text)) = reply {
                block.push_str(&format!("[Coordinator · seq {seq}]\n{}\n\n", text.trim()));
            }
            (exchange.users[0].0, block)
        })
        .collect();
    let keep = blocks.len().saturating_sub(RECENT_EXCHANGES);
    blocks.drain(..keep);
    while blocks.len() > 1 && blocks.iter().map(|(_, block)| block.len()).sum::<usize>() > RECENT_MAX_BYTES {
        blocks.remove(0);
    }
    let first = blocks.first().map(|(seq, _)| *seq);
    let mut text: String = blocks.into_iter().map(|(_, block)| block).collect();
    if text.len() > RECENT_MAX_BYTES {
        super::truncate_utf8(&mut text, RECENT_MAX_BYTES);
        text.push('…');
    }
    (text.trim_end().to_owned(), first)
}

/// The project's git repositories as a lead sees them, for checking a handoff.
struct GitRepos {
    targets: Vec<group_git::RepoTarget>,
    /// Paths deleted or renamed away since the last rotation.
    removed: HashSet<String>,
}

impl GitRepos {
    async fn for_thread(thread: &Thread, since: DateTime<Utc>) -> Self {
        let targets: Vec<_> = group_git::targets(thread).into_iter().filter(|target| target.dir.join(".git").exists()).collect();
        let mut removed = HashSet::new();
        let since = since.to_rfc3339();
        for target in &targets {
            let repo = kybern_git::Repo::new(&target.dir);
            let since_arg = format!("--since={since}");
            let Ok(out) = repo.output(&["log", &since_arg, "--diff-filter=DR", "--name-status", "-M", "--format="]).await else { continue };
            for line in out.stdout.lines() {
                let mut fields = line.split('\t');
                let (Some(_status), Some(old)) = (fields.next(), fields.next()) else { continue };
                removed.insert(prefixed(target, old));
            }
        }
        Self { targets, removed }
    }

    fn is_empty(&self) -> bool {
        self.targets.is_empty()
    }

    async fn has_commit(&self, sha: &str) -> bool {
        let object = format!("{sha}^{{commit}}");
        for target in &self.targets {
            if kybern_git::Repo::new(&target.dir).output(&["cat-file", "-e", &object]).await.is_ok_and(|out| out.success) {
                return true;
            }
        }
        false
    }

    /// A path at HEAD or in the checkout, a ref (a branch name), or one removed since the last rotation.
    async fn knows_path(&self, path: &str) -> bool {
        let path = path.trim_start_matches("./").trim_end_matches('/');
        if path.is_empty() || self.removed.contains(path) {
            return true;
        }
        if let Some((target, relative)) = group_git::route_path(&self.targets, path) {
            if relative.is_empty() || Path::new(&target.dir).join(&relative).exists() {
                return true;
            }
            let object = format!("HEAD:{relative}");
            if kybern_git::Repo::new(&target.dir).output(&["cat-file", "-e", &object]).await.is_ok_and(|out| out.success) {
                return true;
            }
        }
        let reference = format!("{path}^{{commit}}");
        for target in &self.targets {
            if kybern_git::Repo::new(&target.dir)
                .output(&["rev-parse", "--verify", "--quiet", &reference])
                .await
                .is_ok_and(|out| out.success)
            {
                return true;
            }
        }
        false
    }
}

/// A repository-relative path as the thread names it (`member/path` in a group).
fn prefixed(target: &group_git::RepoTarget, path: &str) -> String {
    match target.repo.as_deref() {
        Some(repo) if repo != "." => format!("{repo}/{path}"),
        _ => path.to_owned(),
    }
}

fn rotation_heads_key(thread: ThreadId) -> String {
    format!("rotation_heads:{thread}")
}

/// A change-report commit line: `- abc1234 Subject …` (any indentation).
fn is_commit_line(line: &str) -> bool {
    let rest = line.trim_start().strip_prefix("- ").unwrap_or("");
    let sha: String = rest.chars().take_while(|c| c.is_ascii_hexdigit()).collect();
    sha.len() >= 7 && rest[sha.len()..].starts_with(' ')
}

#[cfg(test)]
mod unit_tests {
    use super::*;

    #[test]
    fn commit_lines_are_counted_from_the_change_report() {
        assert!(is_commit_line("  - def5678 Remove pre-launch fallback (Alex): deleted `src/auth/prelaunch.ts`"));
        assert!(!is_commit_line("- ade · main: 3 commits (abc1234..def5678)"));
        assert!(!is_commit_line("  - +4 more (kybern_git log for the rest)"));
    }

    #[test]
    fn headings_tokens_and_paths_are_recognised() {
        let text = "Sure, here it is.\n## Goals\nShip\n## Decisions (date, what, why, commit if any)\nNone\n## Reversals and removals\n\
                    None\n## User preferences\nNone\n## Open questions\nNone\n## Next steps\nNone";
        assert_eq!(heading_line(text, "Goals"), Some(2));
        assert_eq!(heading_line(text, "Decisions"), Some(4));
        assert!(handoff_body(text).starts_with("## Goals"), "the preamble is dropped");
        assert_eq!(backticked("use `abc1234` and `src/a.ts` or ``").collect::<Vec<_>>(), vec!["abc1234", "src/a.ts"]);
        assert!(is_sha("abc1234") && !is_sha("abc123") && !is_sha("abcdefg"));
        for path in ["src/auth/session.ts", "Cargo.toml", "apps/desktop/", "README.md"] {
            assert!(looks_like_path(path), "{path}");
        }
        for not in ["kybern_thread_read", "npm test", "self.inner", "0.16.0", "src/**", "https://x.y/z", "Option<String>", "/etc/hosts"] {
            assert!(!looks_like_path(not), "{not}");
        }
        let id = Uuid::now_v7();
        assert_eq!(uuids(&format!("thread {id}, done")), vec![id]);
        assert_eq!(tokens_label(212_345), "212k");
    }

    #[test]
    fn a_seed_handoff_section_is_replaced_in_place() {
        let mut seed = RotationSeed { rotation_id: "r".into(), text: String::new(), handoff: (0, 0) };
        seed.text.push_str("intro\n\n");
        let start = seed.text.len();
        seed.text.push_str(&handoff_section(None, &HandoffStatus::Missing { why: "timed out.".into() }, false));
        seed.handoff = (start, seed.text.len());
        seed.text.push_str("\n\n## Facts");
        assert!(seed.text.contains("No handoff: timed out. Rely on"));
        seed.replace_handoff(&handoff_section(Some("## Goals\nShip"), &HandoffStatus::Written, true));
        assert_eq!(seed.text, "intro\n\n## Handoff (written by the previous session, edited by the user)\n## Goals\nShip\n\n## Facts");
    }
}
