//! Orchestrator V2 thread-to-thread messaging and shared-checkout guards.
//!
//! `kybern_thread_send` lives here (`docs/design/orchestrator-v2.md` section 2.7):
//! recipient checks, the permission gate that turns a blocked message into a held
//! one, the per-pair wake cap, steer-or-queue delivery, replies (explicit,
//! automatic and returned inline to a blocked asker) and the RPCs that deliver or
//! dismiss a held message. The second half (section 4.2) watches the files a
//! shared-checkout child edits and warns it when it strays onto a sibling's
//! `owns` globs.
//!
//! Lock rules, as in `delegation.rs`: never hold a session's `turn` lock while
//! delivering to another thread (two threads messaging each other would deadlock),
//! and deliver from a spawned task whenever the caller is inside the event pump,
//! which holds the sender's turn lock.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow, bail, ensure};
use chrono::Utc;
use kybern_protocol::*;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::oneshot;
use uuid::Uuid;

use super::delegation::{self, TurnOutcome, harness_supports_steer};
use super::{LiveSession, Orchestrator};

/// Names of the tools this module serves.
pub(crate) const TOOL_NAMES: [&str; 1] = ["kybern_thread_send"];

pub(crate) fn is_tool(name: &str) -> bool {
    TOOL_NAMES.contains(&name)
}

/// Longest message body an agent may send (UTF-8 bytes).
const BODY_MAX_BYTES: usize = 32 * 1024;
/// Messages two threads may exchange before a person speaks in either of them.
const PAIR_WAKE_CAP: usize = 16;
const WAIT_DEFAULT_MS: u64 = 55_000;
const WAIT_MAX_MS: u64 = 60_000;
const FILES_TOUCHED_CAP: usize = 200;
/// `ThreadUpdated` for a child's growing `files_touched` goes out at most this often.
const THREAD_UPDATE_INTERVAL: Duration = Duration::from_secs(1);
const MAX_REMEMBERED_CALLS: usize = 256;
const MAX_CONSUMED_PER_THREAD: usize = 64;

/// Daemon-side state of the messaging engine.
#[derive(Default)]
pub(super) struct MessagingState {
    /// Asks a tool call is blocked on (`wait_for_reply`), by question id.
    waiters: std::sync::Mutex<HashMap<MessageId, oneshot::Sender<ThreadMessageRecord>>>,
    /// Questions each thread's running turns consumed and still owe an answer.
    consumed: std::sync::Mutex<HashMap<ThreadId, Vec<(TurnId, MessageId)>>>,
    /// Serializes delivering and dismissing held messages so a double click acts once.
    resolve: tokio::sync::Mutex<()>,
    guard: std::sync::Mutex<GuardState>,
}

#[derive(Default)]
struct GuardState {
    /// When each child's `ThreadUpdated` last went out.
    last_publish: HashMap<ThreadId, Instant>,
    /// Children with a trailing `ThreadUpdated` scheduled.
    trailing: HashSet<ThreadId>,
    /// Names of Cursor ACP tool calls, whose paths are only known at completion.
    call_names: HashMap<(ThreadId, String), String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SendArgs {
    #[serde(default)]
    operation_id: Option<Uuid>,
    thread_id: ThreadId,
    body: String,
    #[serde(default)]
    purpose: Option<ThreadMessagePurpose>,
    #[serde(default)]
    reply_to: Option<MessageId>,
    #[serde(default)]
    delivery: Option<ThreadMessageDelivery>,
    #[serde(default)]
    wait_for_reply: Option<bool>,
    #[serde(default)]
    timeout_ms: Option<u64>,
}

/// The permission rule for messages between threads: the sender may wake a
/// recipient only when the recipient cannot do more than the sender could.
/// `Err` carries the reason a message is held for the user. Shared with the
/// collaboration path, which adds its own worktree rule on top.
pub(super) fn permission_rule(actor: &Thread, recipient: &Thread) -> std::result::Result<(), &'static str> {
    let safe = actor.permission_mode == PermissionMode::FullAccess
        || recipient.permission_mode == PermissionMode::Supervised
        || (actor.provider.kind == recipient.provider.kind && actor.permission_mode == recipient.permission_mode);
    if safe {
        Ok(())
    } else {
        Err("The recipient's permission mode is not a conservative subset of the sender's, so a person has to approve this message.")
    }
}

impl Orchestrator {
    // ---- kybern_thread_send ----

    pub(super) async fn execute_messaging_tool(
        &self,
        thread: &Thread,
        turn_id: TurnId,
        live: &LiveSession,
        name: &str,
        arguments: Value,
    ) -> Result<Value> {
        match name {
            "kybern_thread_send" => self.thread_send(thread, turn_id, live, crate::app_tools::parse(arguments)?).await,
            _ => bail!("unknown Kybern messaging tool: {name}"),
        }
    }

    async fn thread_send(&self, sender: &Thread, turn_id: TurnId, live: &LiveSession, args: SendArgs) -> Result<Value> {
        let operation_id = args.operation_id.unwrap_or_else(Uuid::now_v7);
        let purpose = args.purpose.unwrap_or(ThreadMessagePurpose::Message);
        ensure!(
            matches!(purpose, ThreadMessagePurpose::Message | ThreadMessagePurpose::Question | ThreadMessagePurpose::Reply),
            "purpose must be message, question or reply."
        );
        let wait = args.wait_for_reply.unwrap_or(false);
        ensure!(!wait || purpose == ThreadMessagePurpose::Question, "wait_for_reply only applies to purpose \"question\".");
        let timeout = Duration::from_millis(args.timeout_ms.unwrap_or(WAIT_DEFAULT_MS).clamp(1, WAIT_MAX_MS));
        let body = args.body.trim().to_owned();
        ensure!(!body.is_empty(), "body is required: write the message to the other thread.");
        ensure!(body.len() <= BODY_MAX_BYTES, "body is too long (max 32 KiB). Summarize it or point to a file.");
        match purpose {
            ThreadMessagePurpose::Reply => {
                ensure!(args.reply_to.is_some(), "A reply needs reply_to: the id of the question you are answering.")
            }
            _ => ensure!(args.reply_to.is_none(), "reply_to is only for purpose \"reply\"."),
        }

        if let Some(existing) = self.inner.store.thread_message_find_by_operation(operation_id)? {
            ensure!(
                existing.from_thread_id == Some(sender.id),
                "operation_id already belongs to another thread's message. Use a fresh request_key."
            );
            let to =
                self.inner.store.thread_get(existing.to_thread_id)?.ok_or_else(|| anyhow!("The recipient thread no longer exists."))?;
            let waiter = (wait && existing.purpose == ThreadMessagePurpose::Question).then(|| self.register_waiter(existing.id));
            return self.send_outcome(existing, &to, waiter.map(|rx| (rx, timeout))).await;
        }

        let recipient = self.inner.store.thread_get(args.thread_id)?.ok_or_else(|| {
            anyhow!("Thread not found. Use kybern_threads_search to find the thread id; a thread id is the uuid in @thread[<id>].")
        })?;
        ensure!(recipient.id != sender.id, "You cannot message your own thread.");
        ensure!(recipient.subagent.is_none(), super::subagents::READ_ONLY_ERROR);
        ensure!(
            recipient.status != ThreadStatus::Archived,
            "That thread is archived. Ask the user to unarchive it, or start a new agent with kybern_agent_delegate."
        );
        Self::ensure_turn_active(live, turn_id).await?;

        if purpose == ThreadMessagePurpose::Reply {
            let original =
                self.inner.store.thread_message_get(args.reply_to.expect("checked above"))?.ok_or_else(|| {
                    anyhow!("Unknown reply_to. Use the id printed in the question you received (the \"id\" in its header).")
                })?;
            ensure!(
                original.purpose == ThreadMessagePurpose::Question
                    && original.to_thread_id == sender.id
                    && original.from_thread_id == Some(recipient.id),
                "reply_to must be a question that thread asked you, and thread_id must be the thread that asked it."
            );
            ensure!(
                original.state != ThreadMessageState::Answered,
                "That question already has a reply. Send purpose \"message\" to follow up."
            );
            ensure!(
                matches!(original.state, ThreadMessageState::Queued | ThreadMessageState::Steered | ThreadMessageState::Delivered),
                "That question was never delivered to you."
            );
            let reply = self.record_reply(&original, sender, &recipient, operation_id, body, args.delivery.unwrap_or_default()).await?;
            return self.send_outcome(reply, &recipient, None).await;
        }

        // The permission gate: a blocked message waits for the user in the recipient.
        let held_reason = permission_rule(sender, &recipient).err().map(str::to_owned);
        if held_reason.is_none() {
            let used = self.pair_message_count(sender.id, recipient.id)?;
            ensure!(
                used < PAIR_WAKE_CAP,
                "These two threads have already exchanged {used} messages without a person speaking in either. Stop messaging; report to the user or wait until they write in one of these threads."
            );
        }
        let now = Utc::now();
        let mut record = ThreadMessageRecord {
            id: Uuid::now_v7(),
            operation_id,
            from_thread_id: Some(sender.id),
            to_thread_id: recipient.id,
            purpose,
            reply_to: None,
            body,
            delivery: args.delivery.unwrap_or_default(),
            state: if held_reason.is_some() { ThreadMessageState::Held } else { ThreadMessageState::Queued },
            held_reason: held_reason.clone(),
            created_at: now,
            updated_at: now,
        };
        self.inner.store.thread_message_insert(&record)?;
        if held_reason.is_some() {
            self.emit(recipient.id, None, EventPayload::ThreadMessageHeld { message: record.clone() })?;
            return self.send_outcome(record, &recipient, None).await;
        }
        let waiter = wait.then(|| self.register_waiter(record.id));
        match self.deliver_thread_message(&record).await {
            Ok(state) => record.state = state,
            Err(error) => {
                self.inner.messaging.waiters.lock().unwrap_or_else(|error| error.into_inner()).remove(&record.id);
                let _ = self.inner.store.thread_message_update_state(record.id, ThreadMessageState::Failed);
                return Err(error);
            }
        }
        self.send_outcome(record, &recipient, waiter.map(|rx| (rx, timeout))).await
    }

    /// Messages the pair exchanged since a person last spoke in either thread.
    /// Replies count but are never refused, so a question can always be answered.
    fn pair_message_count(&self, a: ThreadId, b: ThreadId) -> Result<usize> {
        let since = [a, b]
            .into_iter()
            .map(|id| self.inner.store.thread_latest_person_turn_at(id))
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .flatten()
            .max();
        Ok(self
            .inner
            .store
            .thread_message_list_for_thread(a, None, 200)?
            .into_iter()
            .filter(|message| {
                matches!(message.purpose, ThreadMessagePurpose::Message | ThreadMessagePurpose::Question | ThreadMessagePurpose::Reply)
                    && !matches!(message.state, ThreadMessageState::Held | ThreadMessageState::Dismissed | ThreadMessageState::Failed)
                    && since.is_none_or(|since| message.created_at >= since)
                    && ((message.from_thread_id == Some(a) && message.to_thread_id == b)
                        || (message.from_thread_id == Some(b) && message.to_thread_id == a))
            })
            .count())
    }

    fn register_waiter(&self, question_id: MessageId) -> oneshot::Receiver<ThreadMessageRecord> {
        let (tx, rx) = oneshot::channel();
        self.inner.messaging.waiters.lock().unwrap_or_else(|error| error.into_inner()).insert(question_id, tx);
        rx
    }

    /// Build the tool result for `record`, waiting for the reply when asked to.
    async fn send_outcome(
        &self,
        record: ThreadMessageRecord,
        to: &Thread,
        waiter: Option<(oneshot::Receiver<ThreadMessageRecord>, Duration)>,
    ) -> Result<Value> {
        let mut reply = None;
        let mut timed_out = false;
        if let Some((mut rx, timeout)) = waiter {
            // A retry of a call whose reply already arrived returns it at once.
            let existing = self.inner.store.thread_message_find_reply(record.id)?;
            if record.state == ThreadMessageState::Held {
                self.inner.messaging.waiters.lock().unwrap_or_else(|error| error.into_inner()).remove(&record.id);
            } else if let Some(existing) = existing {
                self.inner.messaging.waiters.lock().unwrap_or_else(|error| error.into_inner()).remove(&record.id);
                reply = Some(existing);
            } else {
                reply = match tokio::time::timeout(timeout, &mut rx).await {
                    Ok(Ok(found)) => Some(found),
                    _ => {
                        self.inner.messaging.waiters.lock().unwrap_or_else(|error| error.into_inner()).remove(&record.id);
                        // A reply that raced the timeout is still ours.
                        rx.close();
                        rx.try_recv().ok()
                    }
                };
                timed_out = reply.is_none();
            }
        }
        let record = self.inner.store.thread_message_get(record.id)?.unwrap_or(record);
        Ok(send_response(&record, to, reply.as_ref(), timed_out))
    }

    // ---- delivery ----

    /// Hand a recorded message to its recipient: steer into the running turn when
    /// asked and the harness can, otherwise queue it (the queue drains when the
    /// recipient is idle). Returns the state the message is now in. A message
    /// from a delegating parent reopens a finished child.
    async fn deliver_thread_message(&self, record: &ThreadMessageRecord) -> Result<ThreadMessageState> {
        let recipient =
            self.inner.store.thread_get(record.to_thread_id)?.ok_or_else(|| anyhow!("The recipient thread no longer exists."))?;
        ensure!(recipient.subagent.is_none(), super::subagents::READ_ONLY_ERROR);
        ensure!(recipient.status != ThreadStatus::Archived, "That thread is archived. Ask the user to unarchive it.");
        let from_title = match record.from_thread_id {
            Some(id) => self.inner.store.thread_get(id)?.map_or_else(|| "Unknown thread".to_string(), |thread| thread.title),
            None => "Kybern".to_string(),
        };
        let message = UserMessage {
            parts: vec![ContentPart::ThreadMessage {
                message_id: record.id,
                from_thread_id: record.from_thread_id,
                from_title,
                purpose: record.purpose,
                reply_to: record.reply_to,
                body: record.body.clone(),
            }],
        };

        let reopened = match (&recipient.delegation, record.from_thread_id) {
            (Some(info), Some(from))
                if from == info.parent_thread_id
                    && info.status != DelegationStatus::Running
                    && matches!(
                        record.purpose,
                        ThreadMessagePurpose::Message | ThreadMessagePurpose::Question | ThreadMessagePurpose::Reply
                    ) =>
            {
                if info.worktree_state == Some(WorktreeState::Removed) {
                    return Err(delegation::worktree_removed_error());
                }
                self.delegation_reopen(recipient.id)?
            }
            _ => None,
        };

        let queued = methods::QueuedMessage { id: record.id, thread_id: recipient.id, message };
        let delivered = async {
            if record.delivery == ThreadMessageDelivery::Steer
                && matches!(recipient.status, ThreadStatus::Running | ThreadStatus::AwaitingApproval)
                && harness_supports_steer(recipient.provider.kind)
            {
                match self.steer(queued.clone()).await {
                    Ok(sent) => {
                        if record.purpose == ThreadMessagePurpose::Question {
                            self.messaging_remember_consumed(recipient.id, sent.turn_id, record.id);
                        }
                        return Ok(ThreadMessageState::Steered);
                    }
                    Err(error) => {
                        tracing::debug!(thread_id = %recipient.id, %error, "steering a thread message failed; queueing it instead")
                    }
                }
            }
            self.enqueue(queued)?;
            Ok::<_, anyhow::Error>(ThreadMessageState::Queued)
        }
        .await;
        match delivered {
            Ok(state) => {
                // The queue worker may already have started the turn that consumes it.
                let current = self.inner.store.thread_message_get(record.id)?.map(|stored| stored.state);
                if current.is_none_or(|current| matches!(current, ThreadMessageState::Held | ThreadMessageState::Queued)) {
                    self.inner.store.thread_message_update_state(record.id, state)?;
                }
                Ok(state)
            }
            Err(error) => {
                if let Some(previous) = reopened {
                    self.delegation_restore(recipient.id, previous);
                }
                Err(error)
            }
        }
    }

    fn messaging_remember_consumed(&self, thread_id: ThreadId, turn_id: TurnId, question_id: MessageId) {
        let mut consumed = self.inner.messaging.consumed.lock().unwrap_or_else(|error| error.into_inner());
        let entries = consumed.entry(thread_id).or_default();
        if !entries.iter().any(|(_, id)| *id == question_id) {
            if entries.len() >= MAX_CONSUMED_PER_THREAD {
                entries.remove(0);
            }
            entries.push((turn_id, question_id));
        }
    }

    // ---- replies ----

    /// Record `replier`'s answer to `original` and deliver it to the asker. A reply
    /// to a question the asker is blocked on goes straight back to that tool call:
    /// recorded as delivered, never queued as a new turn.
    async fn record_reply(
        &self,
        original: &ThreadMessageRecord,
        replier: &Thread,
        asker: &Thread,
        operation_id: Uuid,
        body: String,
        delivery: ThreadMessageDelivery,
    ) -> Result<ThreadMessageRecord> {
        if let Some(existing) = self.inner.store.thread_message_find_by_operation(operation_id)? {
            return Ok(existing);
        }
        let now = Utc::now();
        let mut reply = ThreadMessageRecord {
            id: Uuid::now_v7(),
            operation_id,
            from_thread_id: Some(replier.id),
            to_thread_id: asker.id,
            purpose: ThreadMessagePurpose::Reply,
            reply_to: Some(original.id),
            body,
            delivery,
            state: ThreadMessageState::Queued,
            held_reason: None,
            created_at: now,
            updated_at: now,
        };
        self.inner.store.thread_message_insert(&reply)?;
        let blocked = self.inner.messaging.waiters.lock().unwrap_or_else(|error| error.into_inner()).remove(&original.id);
        if let Some(waiter) = blocked
            && waiter.send(reply.clone()).is_ok()
        {
            reply.state = ThreadMessageState::Delivered;
            self.inner.store.thread_message_update_state(reply.id, ThreadMessageState::Delivered)?;
            self.inner.store.thread_message_update_state(original.id, ThreadMessageState::Answered)?;
            return Ok(reply);
        }
        match self.deliver_thread_message(&reply).await {
            Ok(state) => reply.state = state,
            Err(error) => {
                let _ = self.inner.store.thread_message_update_state(reply.id, ThreadMessageState::Failed);
                return Err(error);
            }
        }
        self.inner.store.thread_message_update_state(original.id, ThreadMessageState::Answered)?;
        Ok(reply)
    }

    // ---- hooks from the turn lifecycle ----

    /// A turn started with `message_id` as its user message. A queued thread
    /// message that was waiting for it is now delivered; a question owes an answer.
    pub(super) fn messaging_turn_started(&self, thread_id: ThreadId, turn_id: TurnId, message_id: MessageId) {
        let record = match self.inner.store.thread_message_get(message_id) {
            Ok(Some(record)) if record.to_thread_id == thread_id => record,
            _ => return,
        };
        if record.state == ThreadMessageState::Queued
            && let Err(error) = self.inner.store.thread_message_update_state(record.id, ThreadMessageState::Delivered)
        {
            tracing::warn!(%message_id, %error, "could not mark a thread message delivered");
        }
        if record.purpose == ThreadMessagePurpose::Question
            && matches!(record.state, ThreadMessageState::Queued | ThreadMessageState::Delivered)
        {
            self.messaging_remember_consumed(thread_id, turn_id, record.id);
        }
    }

    /// A queued follow-up was removed before it started; a thread message in it is dismissed.
    pub(super) fn messaging_queue_removed(&self, thread_id: ThreadId, message_id: MessageId) {
        if let Ok(Some(record)) = self.inner.store.thread_message_get(message_id)
            && record.to_thread_id == thread_id
            && record.state == ThreadMessageState::Queued
        {
            let _ = self.inner.store.thread_message_update_state(record.id, ThreadMessageState::Dismissed);
        }
    }

    /// A turn of `thread_id` ended. Every question it consumed that nobody answered
    /// explicitly gets the turn's final assistant text as its reply.
    pub(super) async fn messaging_turn_finished(&self, thread_id: ThreadId, turn_id: TurnId, outcome: &TurnOutcome) {
        let owed: Vec<MessageId> = {
            let mut consumed = self.inner.messaging.consumed.lock().unwrap_or_else(|error| error.into_inner());
            let Some(entries) = consumed.get_mut(&thread_id) else { return };
            let owed = entries.iter().filter(|(turn, _)| *turn == turn_id).map(|(_, id)| *id).collect();
            entries.retain(|(turn, _)| *turn != turn_id);
            if entries.is_empty() {
                consumed.remove(&thread_id);
            }
            owed
        };
        for question_id in owed {
            if let Err(error) = self.auto_reply(thread_id, turn_id, question_id, outcome).await {
                tracing::warn!(%thread_id, %question_id, %error, "could not send the automatic reply to a question");
            }
        }
    }

    async fn auto_reply(&self, thread_id: ThreadId, turn_id: TurnId, question_id: MessageId, outcome: &TurnOutcome) -> Result<()> {
        let Some(question) = self.inner.store.thread_message_get(question_id)? else { return Ok(()) };
        if question.state == ThreadMessageState::Answered || self.inner.store.thread_message_find_reply(question.id)?.is_some() {
            return Ok(());
        }
        let Some(asker_id) = question.from_thread_id else { return Ok(()) };
        let (Some(replier), Some(asker)) = (self.inner.store.thread_get(thread_id)?, self.inner.store.thread_get(asker_id)?) else {
            return Ok(());
        };
        let blocked = self.inner.messaging.waiters.lock().unwrap_or_else(|error| error.into_inner()).contains_key(&question.id);
        // A delegated child answering its parent already reports through the batched
        // results message; repeating the text would wake the parent twice.
        if !blocked
            && replier.delegation.as_ref().is_some_and(|info| info.status == DelegationStatus::Running && info.parent_thread_id == asker_id)
        {
            self.inner.store.thread_message_update_state(question.id, ThreadMessageState::Answered)?;
            return Ok(());
        }
        let text = match outcome {
            TurnOutcome::Completed { stop_reason: StopReason::Completed | StopReason::MaxTurns, terminal_message_id } => self
                .last_assistant_text(thread_id, Some(turn_id), *terminal_message_id)
                .unwrap_or_else(|| "The recipient finished its turn without a written answer.".to_string()),
            TurnOutcome::Completed { terminal_message_id, .. } => {
                let partial = self.last_assistant_text(thread_id, Some(turn_id), *terminal_message_id);
                format!(
                    "The recipient's turn ended before it answered.{}",
                    partial.map(|text| format!(" Its last message:\n{text}")).unwrap_or_default()
                )
            }
            TurnOutcome::Failed(error) => format!("The recipient's turn failed before it answered: {error}"),
        };
        self.record_reply(&question, &replier, &asker, derived(question.id, 0x61), text, ThreadMessageDelivery::Queue).await?;
        Ok(())
    }

    // ---- held messages ----

    /// The user approves a held message: it goes out with the delivery the sender asked for.
    pub async fn thread_message_deliver(&self, message_id: MessageId) -> Result<ThreadMessageRecord> {
        let _resolving = self.inner.messaging.resolve.lock().await;
        let record = self.inner.store.thread_message_get(message_id)?.ok_or_else(|| anyhow!("That message no longer exists."))?;
        match record.state {
            ThreadMessageState::Held => {}
            ThreadMessageState::Queued | ThreadMessageState::Steered | ThreadMessageState::Delivered | ThreadMessageState::Answered => {
                return Ok(record);
            }
            ThreadMessageState::Dismissed => bail!("This message was dismissed. Ask the sender to send it again."),
            ThreadMessageState::Failed => bail!("This message could not be delivered. Ask the sender to send it again."),
        }
        let state = self.deliver_thread_message(&record).await?;
        let updated =
            self.inner.store.thread_message_update_state(record.id, state)?.ok_or_else(|| anyhow!("That message no longer exists."))?;
        self.emit(record.to_thread_id, None, EventPayload::ThreadMessageResolved { message_id, resolution: HeldResolution::Delivered })?;
        Ok(updated)
    }

    /// The user dismisses a held message; the recipient never sees it.
    pub async fn thread_message_dismiss(&self, message_id: MessageId) -> Result<ThreadMessageRecord> {
        let _resolving = self.inner.messaging.resolve.lock().await;
        let record = self.inner.store.thread_message_get(message_id)?.ok_or_else(|| anyhow!("That message no longer exists."))?;
        match record.state {
            ThreadMessageState::Held => {}
            ThreadMessageState::Dismissed => return Ok(record),
            _ => bail!("This message was already delivered, so it cannot be dismissed."),
        }
        let updated = self
            .inner
            .store
            .thread_message_update_state(record.id, ThreadMessageState::Dismissed)?
            .ok_or_else(|| anyhow!("That message no longer exists."))?;
        self.emit(record.to_thread_id, None, EventPayload::ThreadMessageResolved { message_id, resolution: HeldResolution::Dismissed })?;
        Ok(updated)
    }

    // ---- shared-checkout guards (section 4.2) ----

    /// A tool call started in `thread_id`. For a running shared-workspace child,
    /// record the files it edits and warn it when one is owned by a sibling.
    pub(super) fn guard_tool_started(&self, thread_id: ThreadId, provider: ProviderKind, call: &ToolCall) {
        let paths = kybern_drivers::edit_paths::edited_paths(call);
        if paths.is_empty() {
            if provider == ProviderKind::Cursor {
                let mut guard = self.inner.messaging.guard.lock().unwrap_or_else(|error| error.into_inner());
                if guard.call_names.len() >= MAX_REMEMBERED_CALLS {
                    guard.call_names.clear();
                }
                guard.call_names.insert((thread_id, call.id.clone()), call.name.clone());
            }
            return;
        }
        self.guard_record_edits(thread_id, paths);
    }

    /// A tool call finished. Cursor's ACP reports the files it wrote only now.
    pub(super) fn guard_tool_completed(&self, thread_id: ThreadId, tool_call_id: &str, output: &Value) {
        let name = {
            let mut guard = self.inner.messaging.guard.lock().unwrap_or_else(|error| error.into_inner());
            if guard.call_names.is_empty() {
                return;
            }
            guard.call_names.remove(&(thread_id, tool_call_id.to_string()))
        };
        let Some(name) = name else { return };
        let paths = kybern_drivers::edit_paths::edited_paths_from_completion(&name, output);
        if !paths.is_empty() {
            self.guard_record_edits(thread_id, paths);
        }
    }

    fn guard_record_edits(&self, thread_id: ThreadId, raw_paths: Vec<String>) {
        if let Err(error) = self.guard_record_edits_inner(thread_id, raw_paths) {
            tracing::warn!(%thread_id, %error, "could not record the files a delegated agent edits");
        }
    }

    fn guard_record_edits_inner(&self, thread_id: ThreadId, raw_paths: Vec<String>) -> Result<()> {
        let Some(thread) = self.inner.store.thread_get(thread_id)? else { return Ok(()) };
        let Some(info) = thread.delegation.as_ref() else { return Ok(()) };
        if info.status != DelegationStatus::Running || info.workspace != DelegationWorkspace::Shared {
            return Ok(());
        }
        let mut paths: Vec<String> = Vec::new();
        for raw in &raw_paths {
            if let Some(path) = kybern_drivers::edit_paths::normalize_edit_path(Path::new(&thread.cwd), raw)
                && !paths.contains(&path)
            {
                paths.push(path);
            }
        }
        if paths.is_empty() {
            return Ok(());
        }
        // Running shared siblings of the same checkout that declared what they own.
        let siblings: Vec<Thread> = self
            .inner
            .store
            .delegation_children(info.parent_thread_id)?
            .into_iter()
            .filter(|sibling| {
                sibling.id != thread_id
                    && sibling.cwd == thread.cwd
                    && sibling.delegation.as_ref().is_some_and(|other| {
                        other.status == DelegationStatus::Running
                            && other.workspace == DelegationWorkspace::Shared
                            && !other.owns.is_empty()
                    })
            })
            .collect();

        let mut warnings: Vec<(String, Thread)> = Vec::new();
        let changed = self.delegation_update_quiet(thread_id, |info| {
            if info.status != DelegationStatus::Running {
                return false;
            }
            let mut changed = false;
            for path in &paths {
                if !info.files_touched.contains(path) && info.files_touched.len() < FILES_TOUCHED_CAP {
                    info.files_touched.push(path.clone());
                    changed = true;
                }
                for owner in &siblings {
                    let owns = owner.delegation.as_ref().map(|other| other.owns.as_slice()).unwrap_or_default();
                    if owns_path(owns, path) && !info.conflicts.iter().any(|known| known.path == *path && known.owner_thread_id == owner.id)
                    {
                        info.conflicts.push(DelegationConflict { path: path.clone(), owner_thread_id: owner.id, at: Utc::now() });
                        warnings.push((path.clone(), owner.clone()));
                        changed = true;
                    }
                }
            }
            changed
        })?;
        if !changed {
            return Ok(());
        }
        self.guard_publish(thread_id, !warnings.is_empty());
        if !warnings.is_empty() {
            // The event pump holds this child's turn lock; steering it must wait for that.
            let this = self.clone();
            tokio::spawn(async move {
                for (path, owner) in warnings {
                    if let Err(error) = this.send_ownership_warning(thread_id, &path, &owner).await {
                        tracing::warn!(%thread_id, %error, "could not warn an agent about a file a sibling owns");
                    }
                }
            });
        }
        Ok(())
    }

    /// Kybern tells the editing child that `path` belongs to `owner`.
    async fn send_ownership_warning(&self, editor: ThreadId, path: &str, owner: &Thread) -> Result<()> {
        let now = Utc::now();
        let mut record = ThreadMessageRecord {
            id: Uuid::now_v7(),
            operation_id: Uuid::now_v7(),
            from_thread_id: None,
            to_thread_id: editor,
            purpose: ThreadMessagePurpose::Warning,
            reply_to: None,
            body: format!("\"{path}\" is owned by \"{}\". Stop editing it and tell your parent if you need that change.", owner.title),
            delivery: ThreadMessageDelivery::Steer,
            state: ThreadMessageState::Queued,
            held_reason: None,
            created_at: now,
            updated_at: now,
        };
        self.inner.store.thread_message_insert(&record)?;
        match self.deliver_thread_message(&record).await {
            Ok(state) => record.state = state,
            Err(error) => {
                let _ = self.inner.store.thread_message_update_state(record.id, ThreadMessageState::Failed);
                return Err(error);
            }
        }
        Ok(())
    }

    /// Change a delegation and persist it without publishing; the caller decides
    /// when `ThreadUpdated` goes out. Returns whether `change` modified anything.
    fn delegation_update_quiet(&self, thread_id: ThreadId, change: impl FnOnce(&mut DelegationInfo) -> bool) -> Result<bool> {
        let _updates = self.inner.thread_updates.lock().map_err(|_| anyhow!("thread update lock poisoned"))?;
        let Some(mut thread) = self.inner.store.thread_get(thread_id)? else { return Ok(false) };
        let Some(info) = thread.delegation.as_mut() else { return Ok(false) };
        if !change(info) {
            return Ok(false);
        }
        self.inner.store.thread_upsert(&thread)?;
        Ok(true)
    }

    /// Publish `ThreadUpdated` for a child whose files changed: right away the
    /// first time and for conflicts, then at most once per second, with a
    /// trailing update so the last change is never left unannounced.
    fn guard_publish(&self, thread_id: ThreadId, urgent: bool) {
        let delay = {
            let mut guard = self.inner.messaging.guard.lock().unwrap_or_else(|error| error.into_inner());
            let now = Instant::now();
            match guard.last_publish.get(&thread_id).copied() {
                Some(last) if !urgent && now.duration_since(last) < THREAD_UPDATE_INTERVAL => {
                    if !guard.trailing.insert(thread_id) {
                        return;
                    }
                    Some(THREAD_UPDATE_INTERVAL - now.duration_since(last))
                }
                _ => {
                    guard.last_publish.insert(thread_id, now);
                    if guard.last_publish.len() > 1024 {
                        guard.last_publish.retain(|_, at| now.duration_since(*at) < THREAD_UPDATE_INTERVAL);
                    }
                    None
                }
            }
        };
        match delay {
            None => self.guard_publish_now(thread_id),
            Some(delay) => {
                let this = self.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(delay).await;
                    {
                        let mut guard = this.inner.messaging.guard.lock().unwrap_or_else(|error| error.into_inner());
                        guard.trailing.remove(&thread_id);
                        guard.last_publish.insert(thread_id, Instant::now());
                    }
                    this.guard_publish_now(thread_id);
                });
            }
        }
    }

    fn guard_publish_now(&self, thread_id: ThreadId) {
        let Ok(_updates) = self.inner.thread_updates.lock() else { return };
        match self.inner.store.thread_get(thread_id) {
            Ok(Some(thread)) => {
                if let Err(error) = self.write_thread_update(thread, false) {
                    tracing::warn!(%thread_id, %error, "could not publish a delegated agent's files");
                }
            }
            Ok(None) => {}
            Err(error) => tracing::warn!(%thread_id, %error, "could not read a delegated agent to publish its files"),
        }
    }
}

/// The tool result for a message: where it stands and, for a question the caller
/// waited on, the reply that came back.
fn send_response(record: &ThreadMessageRecord, to: &Thread, reply: Option<&ThreadMessageRecord>, timed_out: bool) -> Value {
    let delivered_as = match record.state {
        ThreadMessageState::Held => "held",
        ThreadMessageState::Steered => "steered",
        _ => "queued",
    };
    let mut response = json!({
        "message_id": record.id,
        "thread_id": to.id,
        "title": to.title,
        "purpose": record.purpose,
        "state": if reply.is_some() && record.purpose == ThreadMessagePurpose::Question { ThreadMessageState::Answered } else { record.state },
        "delivered_as": delivered_as,
    });
    let object = response.as_object_mut().expect("response is an object");
    if let Some(reply) = reply {
        object.insert("reply".into(), json!({"message_id": reply.id, "from_thread_id": reply.from_thread_id, "body": reply.body}));
    }
    if timed_out {
        object.insert("wait_timed_out".into(), json!(true));
    }
    let note = match (record.state, record.purpose) {
        (ThreadMessageState::Held, _) => Some(
            "Held, not delivered: that thread has a more permissive setup than yours, so the user must approve this message in that thread. Do not resend it; carry on or end your turn.",
        ),
        _ if reply.is_some() => None,
        _ if timed_out => Some("No reply yet. End your turn: the reply wakes you when it arrives."),
        (_, ThreadMessagePurpose::Question) => Some("Question sent. End your turn: the reply wakes you when it arrives."),
        (ThreadMessageState::Steered, _) => Some("Delivered into the recipient's running turn."),
        (_, ThreadMessagePurpose::Message) => Some("Queued: the recipient reads it when it is idle or finishes its turn."),
        _ => None,
    };
    if let Some(note) = note {
        object.insert("note".into(), json!(note));
    }
    response
}

fn derived(base: Uuid, discriminator: u8) -> Uuid {
    let mut bytes = *base.as_bytes();
    bytes[0] ^= discriminator;
    Uuid::from_bytes(bytes)
}

// ---- ownership globs ----

/// Whether `path` (checkout-relative, `/`-separated) falls under any of `owns`.
///
/// Patterns support `*` (within one path segment), `**` (any number of segments,
/// including none) and `?` (one character within a segment). A pattern without
/// wildcards also owns everything beneath it, so `src/api` and `src/api/` cover
/// the whole directory. A leading `./` or `/` is ignored.
pub(super) fn owns_path(owns: &[String], path: &str) -> bool {
    let path: Vec<&str> = path.split('/').filter(|part| !part.is_empty() && *part != ".").collect();
    owns.iter().any(|pattern| {
        let trimmed = pattern.trim().trim_start_matches("./").trim_start_matches('/');
        if trimmed.is_empty() {
            return false;
        }
        let mut segments: Vec<&str> = trimmed.split('/').filter(|part| !part.is_empty()).collect();
        if !trimmed.contains(['*', '?']) {
            // A plain path owns what is beneath it too.
            segments.push("**");
        }
        match_segments(&segments, &path)
    })
}

fn match_segments(pattern: &[&str], path: &[&str]) -> bool {
    match pattern.split_first() {
        None => path.is_empty(),
        Some((&"**", rest)) => (0..=path.len()).any(|skip| match_segments(rest, &path[skip..])),
        Some((segment, rest)) => match path.split_first() {
            Some((part, remaining)) => match_segment(segment.as_bytes(), part.as_bytes()) && match_segments(rest, remaining),
            None => false,
        },
    }
}

/// `*` and `?` inside one segment (a lone `**` inside a longer segment acts as `*`).
fn match_segment(pattern: &[u8], text: &[u8]) -> bool {
    let (mut p, mut t) = (0, 0);
    let mut star: Option<(usize, usize)> = None;
    while t < text.len() {
        if p < pattern.len() && (pattern[p] == b'?' || pattern[p] == text[t]) && pattern[p] != b'*' {
            p += 1;
            t += 1;
        } else if p < pattern.len() && pattern[p] == b'*' {
            star = Some((p, t));
            p += 1;
        } else if let Some((star_p, star_t)) = star {
            p = star_p + 1;
            t = star_t + 1;
            star = Some((star_p, star_t + 1));
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == b'*' {
        p += 1;
    }
    p == pattern.len()
}
