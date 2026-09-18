//! Fold a thread's event log into the transcript clients render.

use kybern_protocol::*;
use serde_json::Value;

// Older Codex resume notifications could register the root as its own child
// before binding. Repair the read projection without rewriting event history.
fn root_sessions(events: &[ThreadEvent]) -> std::collections::HashSet<(ThreadId, String)> {
    events
        .iter()
        .filter_map(|event| match &event.payload {
            EventPayload::ProviderSessionBound { session_id, .. } => Some((event.thread_id, session_id.clone())),
            _ => None,
        })
        .collect()
}

fn is_root_task(task: &RuntimeTask, roots: &std::collections::HashSet<(ThreadId, String)>) -> bool {
    task.kind == RuntimeTaskKind::Agent && task.provider_thread_id.as_ref().is_some_and(|id| roots.contains(&(task.thread_id, id.clone())))
}

/// Settled tool results larger than this stay in SQLite until a client asks
/// for the specific call. The cached projection keeps a flag, not the bytes.
pub const LARGE_TOOL_OUTPUT_BYTES: usize = 2048;

fn json_string_bytes(value: &str) -> usize {
    value.chars().fold(2usize, |size, character| {
        size.saturating_add(match character {
            '"' | '\\' | '\u{08}' | '\u{0c}' | '\n' | '\r' | '\t' => 2,
            character if character <= '\u{1f}' => 6,
            character => character.len_utf8(),
        })
    })
}

pub fn json_payload_bytes(value: &Value) -> usize {
    match value {
        Value::Null => 4,
        Value::Bool(value) => {
            if *value {
                4
            } else {
                5
            }
        }
        Value::Number(n) => n.to_string().len(),
        Value::String(s) => json_string_bytes(s),
        Value::Array(items) => items
            .iter()
            .enumerate()
            .fold(2usize, |size, (index, item)| size.saturating_add(usize::from(index > 0)).saturating_add(json_payload_bytes(item))),
        Value::Object(map) => map.iter().enumerate().fold(2usize, |size, (index, (key, child))| {
            size.saturating_add(usize::from(index > 0))
                .saturating_add(json_string_bytes(key))
                .saturating_add(1)
                .saturating_add(json_payload_bytes(child))
        }),
    }
}

fn bounded_add(size: &mut usize, amount: usize, limit: usize) -> bool {
    *size = size.saturating_add(amount);
    *size > limit
}

fn json_string_exceeds(value: &str, size: &mut usize, limit: usize) -> bool {
    if bounded_add(size, 2, limit) {
        return true;
    }
    for character in value.chars() {
        let bytes = match character {
            '"' | '\\' | '\u{08}' | '\u{0c}' | '\n' | '\r' | '\t' => 2,
            character if character <= '\u{1f}' => 6,
            character => character.len_utf8(),
        };
        if bounded_add(size, bytes, limit) {
            return true;
        }
    }
    false
}

/// Count only until the omission threshold is crossed. Live completions can
/// contain tens of megabytes, so deciding to compact one must not scan the
/// entire value when its prefix already proves it is over the limit.
fn json_payload_exceeds(value: &Value, limit: usize) -> bool {
    fn walk(value: &Value, size: &mut usize, limit: usize) -> bool {
        match value {
            Value::Null => bounded_add(size, 4, limit),
            Value::Bool(value) => bounded_add(size, if *value { 4 } else { 5 }, limit),
            Value::Number(value) => bounded_add(size, value.to_string().len(), limit),
            Value::String(value) => json_string_exceeds(value, size, limit),
            Value::Array(items) => {
                if bounded_add(size, 1, limit) {
                    return true;
                }
                for (index, item) in items.iter().enumerate() {
                    if index > 0 && bounded_add(size, 1, limit) {
                        return true;
                    }
                    if walk(item, size, limit) {
                        return true;
                    }
                }
                bounded_add(size, 1, limit)
            }
            Value::Object(map) => {
                if bounded_add(size, 1, limit) {
                    return true;
                }
                for (index, (key, child)) in map.iter().enumerate() {
                    if index > 0 && bounded_add(size, 1, limit) {
                        return true;
                    }
                    if json_string_exceeds(key, size, limit) || bounded_add(size, 1, limit) || walk(child, size, limit) {
                        return true;
                    }
                }
                bounded_add(size, 1, limit)
            }
        }
    }

    let mut size = 0;
    walk(value, &mut size, limit)
}

pub fn should_omit_tool_output(output: &Value) -> bool {
    json_payload_exceeds(output, LARGE_TOOL_OUTPUT_BYTES)
}

#[derive(Default)]
pub struct TranscriptFold {
    omit_tool_outputs: bool,
    out: Vec<TranscriptEntry>,
    turn_started_at: std::collections::HashMap<TurnId, chrono::DateTime<chrono::Utc>>,
    last_turn_id: Option<TurnId>,
    unscoped_assistant_message: Option<(TurnId, MessageId)>,
    roots: std::collections::HashSet<(ThreadId, String)>,
}

impl TranscriptFold {
    pub fn omitting_tool_outputs() -> Self {
        Self { omit_tool_outputs: true, ..Self::default() }
    }

    pub fn apply(&mut self, ev: &ThreadEvent) {
        apply_transcript_event(
            &mut self.out,
            &mut self.turn_started_at,
            &mut self.last_turn_id,
            &mut self.unscoped_assistant_message,
            &mut self.roots,
            ev,
            self.omit_tool_outputs,
        );
    }

    pub fn finish(self) -> Vec<TranscriptEntry> {
        self.out
    }
}

/// Fold append-only runtime task events into one latest-state row per task.
pub fn project_runtime_tasks(events: &[ThreadEvent]) -> Vec<RuntimeTask> {
    use std::collections::hash_map::Entry;

    let roots = root_sessions(events);
    let mut tasks = std::collections::HashMap::<String, RuntimeTask>::new();
    for event in events {
        let (task, restarted) = match &event.payload {
            EventPayload::RuntimeTaskStarted { task } => (task, true),
            EventPayload::RuntimeTaskUpdated { task } | EventPayload::RuntimeTaskCompleted { task } => (task, false),
            _ => continue,
        };
        if is_root_task(task, &roots) {
            continue;
        }
        let mut task = task.clone();
        if task.started_seq == 0 {
            task.started_seq = event.seq;
        }
        task.updated_seq = event.seq;
        match tasks.entry(task.id.clone()) {
            Entry::Vacant(entry) => {
                entry.insert(task);
            }
            Entry::Occupied(mut entry) => {
                let current = entry.get();
                task.started_seq = match (current.started_seq, task.started_seq) {
                    (0, next) => next,
                    (current, 0) => current,
                    (current, next) => current.min(next),
                };
                let newer_by_sequence = task.updated_seq > current.updated_seq;
                let older_by_sequence = task.updated_seq < current.updated_seq && (task.updated_seq > 0 || current.updated_seq > 0);
                let newer = newer_by_sequence
                    || (!older_by_sequence && task.updated_seq == current.updated_seq && task.updated_at > current.updated_at);
                let tied_and_not_regressing = task.updated_seq == current.updated_seq
                    && task.updated_at == current.updated_at
                    && (current.status.is_active() || !task.status.is_active());
                let terminal_regression = !current.status.is_active() && task.status.is_active() && !restarted;
                if !terminal_regression && (newer || tied_and_not_regressing) {
                    entry.insert(task);
                }
            }
        }
    }
    let (active, recent): (Vec<_>, Vec<_>) = tasks.into_values().partition(|task| task.status.is_active());
    let mut ordered = order_runtime_group(active, false);
    ordered.extend(order_runtime_group(recent, true));
    ordered
}

/// Keep live rows in stable launch order and place children directly beneath
/// their parent. Recent rows use newest-first ordering. Progress ticks should
/// never make the Activity roster jump around.
fn order_runtime_group(tasks: Vec<RuntimeTask>, newest_first: bool) -> Vec<RuntimeTask> {
    let ids = tasks.iter().map(|task| task.id.clone()).collect::<std::collections::HashSet<_>>();
    let mut children = std::collections::HashMap::<String, Vec<RuntimeTask>>::new();
    for task in tasks {
        let parent = task.parent_id.as_ref().filter(|parent| ids.contains(*parent)).cloned().unwrap_or_default();
        children.entry(parent).or_default().push(task);
    }
    for siblings in children.values_mut() {
        siblings.sort_by(|left, right| {
            if newest_first {
                right
                    .updated_seq
                    .cmp(&left.updated_seq)
                    .then_with(|| right.updated_at.cmp(&left.updated_at))
                    .then_with(|| left.id.cmp(&right.id))
            } else {
                left.started_seq
                    .cmp(&right.started_seq)
                    .then_with(|| left.started_at.cmp(&right.started_at))
                    .then_with(|| left.id.cmp(&right.id))
            }
        });
    }

    fn append_branch(parent: &str, children: &mut std::collections::HashMap<String, Vec<RuntimeTask>>, out: &mut Vec<RuntimeTask>) {
        for task in children.remove(parent).unwrap_or_default() {
            let id = task.id.clone();
            out.push(task);
            append_branch(&id, children, out);
        }
    }

    let mut ordered = Vec::new();
    append_branch("", &mut children, &mut ordered);
    // A malformed provider cycle must not hide work from clients.
    let mut remaining = children.into_values().flatten().collect::<Vec<_>>();
    remaining.sort_by(|left, right| {
        left.started_seq.cmp(&right.started_seq).then_with(|| left.started_at.cmp(&right.started_at)).then_with(|| left.id.cmp(&right.id))
    });
    ordered.extend(remaining);
    ordered
}

pub fn project_thread_activity(thread_id: ThreadId, tasks: &[RuntimeTask]) -> ThreadActivitySummary {
    let mut summary = ThreadActivitySummary { thread_id, state: None, active_agents: 0, active_processes: 0, active_monitors: 0 };
    for task in tasks.iter().filter(|task| task.status.is_active()) {
        match task.kind {
            RuntimeTaskKind::Agent => summary.active_agents += 1,
            RuntimeTaskKind::Process => summary.active_processes += 1,
            RuntimeTaskKind::Monitor => summary.active_monitors += 1,
        }
    }
    summary.state = if summary.active_agents > 0 {
        Some(ThreadActivityState::Working)
    } else if summary.active_processes > 0 || summary.active_monitors > 0 {
        Some(ThreadActivityState::Monitoring)
    } else {
        None
    };
    summary
}

pub fn project_transcript(events: &[ThreadEvent]) -> Vec<TranscriptEntry> {
    let mut fold = TranscriptFold::default();
    for ev in events {
        fold.apply(ev);
    }
    fold.finish()
}

fn apply_transcript_event(
    out: &mut Vec<TranscriptEntry>,
    turn_started_at: &mut std::collections::HashMap<TurnId, chrono::DateTime<chrono::Utc>>,
    last_turn_id: &mut Option<TurnId>,
    unscoped_assistant_message: &mut Option<(TurnId, MessageId)>,
    roots: &mut std::collections::HashSet<(ThreadId, String)>,
    ev: &ThreadEvent,
    omit_tool_outputs: bool,
) {
    let mut last_turn_id_value = *last_turn_id;
    let mut unscoped_assistant_message_value = *unscoped_assistant_message;
    for ev in std::iter::once(ev) {
        let turn_id = ev.turn_id;
        if turn_id.is_none()
            && matches!(&ev.payload,
            EventPayload::AssistantTextDelta { origin, .. }
            | EventPayload::AssistantThinkingDelta { origin, .. }
            | EventPayload::AssistantMessageCompleted { origin, .. }
            | EventPayload::ToolCallStarted { origin, .. } if origin.is_root())
        {
            for entry in out.iter_mut() {
                if let TranscriptEntry::TurnSummary { turn_id, terminal_message_id, .. } = entry
                    && Some(*turn_id) == last_turn_id_value
                {
                    *terminal_message_id = None;
                }
            }
        }
        match &ev.payload {
            EventPayload::TurnStarted { message_id, message }
            | EventPayload::MessageSteered { message_id, message }
            | EventPayload::AsyncQuestionsAnswered { message_id, message, .. } => {
                if out.iter().any(|entry| matches!(entry, TranscriptEntry::User { id, .. } if id == message_id)) { continue; }
                let Some(turn_id) = turn_id else { continue };
                last_turn_id_value = Some(turn_id);
                unscoped_assistant_message_value = None;
                turn_started_at.entry(turn_id).or_insert(ev.at);
                out.push(TranscriptEntry::User { id: *message_id, turn_id, seq: ev.seq, message: message.clone(), at: ev.at });
            }
            EventPayload::SessionImported { .. } => {
                out.push(TranscriptEntry::Notice { turn_id: last_turn_id_value.unwrap_or_default(), seq: ev.seq, at: ev.at, level: NoticeLevel::Info, text: "Session resumed. Earlier messages are shown above.".into() });
            }
            EventPayload::TurnResumed => {
                let Some(turn_id) = turn_id else { continue };
                last_turn_id_value = Some(turn_id);
                unscoped_assistant_message_value = None;
                out.retain(|entry| !matches!(entry, TranscriptEntry::TurnSummary { turn_id: id, .. } if *id == turn_id));
            }
            EventPayload::ImageReceived { id, origin, source } => {
                if let Some(turn_id) = turn_id.filter(|_| origin.is_root())
                    && !out.iter().any(|entry| matches!(entry, TranscriptEntry::Image { id: previous, turn_id: previous_turn, .. } if previous == id && *previous_turn == turn_id)) {
                        out.push(TranscriptEntry::Image { id: id.clone(), turn_id, seq: ev.seq, at: ev.at, origin: origin.clone(), source: source.clone() });
                }
            }
            EventPayload::AssistantTextDelta { message_id, origin, delta } => {
                if !origin.is_root() {
                    continue;
                }
                let Some((turn_id, message_id)) =
                    assistant_scope(turn_id, last_turn_id_value, *message_id, &mut unscoped_assistant_message_value, false)
                else {
                    continue;
                };
                // The completed event remains the canonical whole message. For
                // presentation, open a new stable segment whenever a row-making
                // event landed since the previous delta so tools and narration
                // keep exact event order without fragmenting the live DOM node.
                match tail_open_assistant(out, message_id, origin) {
                    Some(TranscriptEntry::Assistant { text, .. }) => text.push_str(delta),
                    _ => {
                        let segment = next_segment(out, message_id, origin);
                        out.push(TranscriptEntry::Assistant {
                            id: message_id,
                            turn_id,
                            seq: ev.seq,
                            origin: origin.clone(),
                            segment,
                            text: delta.clone(),
                            thinking: None,
                            at: ev.at,
                            complete: false,
                        });
                    }
                }
            }
            EventPayload::AssistantThinkingDelta { message_id, origin, delta } => {
                if !origin.is_root() {
                    continue;
                }
                let Some((turn_id, message_id)) =
                    assistant_scope(turn_id, last_turn_id_value, *message_id, &mut unscoped_assistant_message_value, false)
                else {
                    continue;
                };
                match tail_open_assistant(out, message_id, origin) {
                    Some(TranscriptEntry::Assistant { thinking, .. }) => thinking.get_or_insert_with(String::new).push_str(delta),
                    _ => {
                        let segment = next_segment(out, message_id, origin);
                        out.push(TranscriptEntry::Assistant {
                            id: message_id,
                            turn_id,
                            seq: ev.seq,
                            origin: origin.clone(),
                            segment,
                            text: String::new(),
                            thinking: Some(delta.clone()),
                            at: ev.at,
                            complete: false,
                        });
                    }
                }
            }
            EventPayload::AssistantMessageCompleted { message_id, origin, text, thinking } => {
                if !origin.is_root() {
                    continue;
                }
                let Some((turn_id, message_id)) =
                    assistant_scope(turn_id, last_turn_id_value, *message_id, &mut unscoped_assistant_message_value, true)
                else {
                    continue;
                };
                let mut segments = assistant_segment_indices(out, message_id, origin);
                if segments.is_empty() {
                    out.push(TranscriptEntry::Assistant {
                        id: message_id,
                        turn_id,
                        seq: ev.seq,
                        origin: origin.clone(),
                        segment: next_segment(out, message_id, origin),
                        text: text.clone(),
                        thinking: thinking.clone(),
                        at: ev.at,
                        complete: true,
                    });
                } else {
                    let last_is_tail = segments.last().is_some_and(|index| *index + 1 == out.len());
                    let trailing_text = (!last_is_tail)
                        .then(|| assistant_field_suffix(out, &segments, text, AssistantField::Text))
                        .flatten()
                        .filter(|suffix| !suffix.is_empty());
                    let trailing_thinking = (!last_is_tail)
                        .then(|| assistant_field_suffix(out, &segments, thinking.as_deref()?, AssistantField::Thinking))
                        .flatten()
                        .filter(|suffix| !suffix.is_empty());
                    if trailing_text.is_some() || trailing_thinking.is_some() {
                        let segment = next_segment(out, message_id, origin);
                        out.push(TranscriptEntry::Assistant {
                            id: message_id,
                            turn_id,
                            seq: ev.seq,
                            origin: origin.clone(),
                            segment,
                            text: trailing_text.unwrap_or_default().to_string(),
                            thinking: trailing_thinking.map(str::to_string),
                            at: ev.at,
                            complete: true,
                        });
                        segments.push(out.len() - 1);
                    }
                    reconcile_assistant_field(out, &segments, text, AssistantField::Text);
                    if let Some(thinking) = thinking {
                        reconcile_assistant_field(out, &segments, thinking, AssistantField::Thinking);
                    }
                    for index in segments {
                        if let TranscriptEntry::Assistant { complete, .. } = &mut out[index] {
                            *complete = true;
                        }
                    }
                }
            }
            EventPayload::ToolCallStarted { call, origin } => {
                let Some(turn_id) = turn_id.or(last_turn_id_value) else { continue };
                out.push(TranscriptEntry::ToolCall {
                    turn_id,
                    seq: ev.seq,
                    origin: origin.clone(),
                    call: call.clone(),
                    output: None,
                    output_omitted: false,
                    is_error: false,
                    complete: false,
                    at: ev.at,
                });
            }
            EventPayload::ToolCallCompleted { tool_call_id, output, output_omitted: _, is_error } => {
                if let Some(TranscriptEntry::ToolCall { output: o, output_omitted, is_error: e, complete, .. }) =
                    out.iter_mut().rev().find(|e| matches!(e, TranscriptEntry::ToolCall { call, .. } if &call.id == tool_call_id))
                {
                    if omit_tool_outputs && should_omit_tool_output(output) {
                        *o = None;
                        *output_omitted = true;
                    } else {
                        *o = Some(output.clone());
                        *output_omitted = false;
                    }
                    *e = *is_error;
                    *complete = true;
                }
            }
            EventPayload::TurnCompleted { stop_reason, usage, cost_usd, duration_ms, terminal_message_id } => {
                let Some(turn_id) = turn_id else { continue };
                last_turn_id_value = Some(turn_id);
                mark_turn_complete(out, turn_id);
                out.push(TranscriptEntry::TurnSummary {
                    turn_id,
                    seq: ev.seq,
                    stop_reason: *stop_reason,
                    usage: usage.clone(),
                    cost_usd: *cost_usd,
                    duration_ms: *duration_ms,
                    terminal_message_id: *terminal_message_id,
                    at: ev.at,
                    error: None,
                });
            }
            EventPayload::TurnFailed { error } => {
                let Some(turn_id) = turn_id else { continue };
                last_turn_id_value = Some(turn_id);
                mark_turn_complete(out, turn_id);
                let duration_ms = turn_started_at.get(&turn_id).map(|s| (ev.at - *s).num_milliseconds().max(0) as u64).unwrap_or(0);
                out.push(TranscriptEntry::TurnSummary {
                    turn_id,
                    seq: ev.seq,
                    stop_reason: StopReason::Error,
                    usage: Usage::default(),
                    cost_usd: None,
                    duration_ms,
                    terminal_message_id: None,
                    at: ev.at,
                    error: Some(error.clone()),
                });
            }
            EventPayload::ApprovalRequested { approval } | EventPayload::UserInputRequested { approval } => {
                let Some(turn_id) = turn_id else { continue };
                out.push(TranscriptEntry::Approval { turn_id, seq: ev.seq, approval: approval.clone(), decision: None });
            }
            EventPayload::ApprovalResolved { approval_id, decision } => {
                if let Some(TranscriptEntry::Approval { decision: d, .. }) =
                    out.iter_mut().rev().find(|e| matches!(e, TranscriptEntry::Approval { approval, .. } if approval.id == *approval_id))
                {
                    *d = Some(decision.clone());
                }
            }
            EventPayload::RuntimeTaskStarted { task }
            | EventPayload::RuntimeTaskUpdated { task }
            | EventPayload::RuntimeTaskCompleted { task } => {
                if is_root_task(task, roots) { continue; }
                let turn_id = turn_id.unwrap_or(task.origin_turn_id);
                let mut incoming = task.clone();
                if incoming.started_seq == 0 {
                    incoming.started_seq = ev.seq;
                }
                incoming.updated_seq = ev.seq;
                if let Some(TranscriptEntry::RuntimeTask { task: current, .. }) =
                    out.iter_mut().find(|entry| matches!(entry, TranscriptEntry::RuntimeTask { task, .. } if task.id == incoming.id))
                {
                    incoming.started_seq = current.started_seq;
                    let restarted = matches!(&ev.payload, EventPayload::RuntimeTaskStarted { .. });
                    if current.status.is_active() || !incoming.status.is_active() || restarted {
                        *current = incoming;
                    }
                } else {
                    out.push(TranscriptEntry::RuntimeTask { turn_id, seq: incoming.started_seq, at: incoming.started_at, task: incoming });
                }
            }
            EventPayload::ProviderNotice { level, text, .. } => {
                let Some(turn_id) = turn_id else { continue };
                out.push(TranscriptEntry::Notice { turn_id, seq: ev.seq, level: *level, text: text.clone(), at: ev.at });
            }
            EventPayload::WorkspaceReverted { commit, .. } => {
                let Some(turn_id) = turn_id else { continue };
                out.push(TranscriptEntry::Reverted { turn_id, seq: ev.seq, commit: commit.clone(), at: ev.at });
            }
            EventPayload::ProviderSessionReleased { reason } => {
                // Releases happen between turns; show them under the last one.
                let (Some(turn_id), Some(text)) = (turn_id.or(last_turn_id_value), reason.notice_text()) else { continue };
                out.push(TranscriptEntry::Notice { turn_id, seq: ev.seq, level: NoticeLevel::Info, text: text.into(), at: ev.at });
            }
            EventPayload::ProviderSessionBound { session_id, .. } => {
                roots.insert((ev.thread_id, session_id.clone()));
                out.retain(|entry| match entry {
                    TranscriptEntry::RuntimeTask { task, .. } => !is_root_task(task, roots),
                    _ => true,
                });
            }
            EventPayload::AsyncQuestionsRequested { .. } | EventPayload::ProviderCommandsUpdated { .. } | EventPayload::ProviderUsageUpdated { .. }
            | EventPayload::ThreadCreated { .. }
            | EventPayload::ThreadUpdated { .. }
            | EventPayload::MessageQueued { .. }
            | EventPayload::MessageQueueUpdated { .. }
            | EventPayload::ProjectCoordinatorDeleted { .. }
            | EventPayload::CollaborationGroupUpdated { .. }
            | EventPayload::CollaborationMemberUpdated { .. }
            | EventPayload::CollaborationAssignmentUpdated { .. }
            | EventPayload::CollaborationMessageUpdated { .. }
            | EventPayload::CollaborationContextUpdated { .. }
            | EventPayload::ThreadNotesUpdated { .. }
            | EventPayload::MessageRemoved { .. }
            | EventPayload::ThreadArchived
            | EventPayload::ToolCallOutputDelta { .. }
            | EventPayload::CheckpointUpdated { .. } => {}
        }
    }
    *last_turn_id = last_turn_id_value;
    *unscoped_assistant_message = unscoped_assistant_message_value;
}

/// Recover legacy Claude continuations that arrived after a provisional result
/// had cleared the daemon's active turn. Those events also received a fresh
/// message id per chunk, so retain the first id until the canonical completion
/// frame closes the continuation.
fn assistant_scope(
    explicit_turn_id: Option<TurnId>,
    last_turn_id: Option<TurnId>,
    provider_message_id: MessageId,
    unscoped_message: &mut Option<(TurnId, MessageId)>,
    complete: bool,
) -> Option<(TurnId, MessageId)> {
    let turn_id = explicit_turn_id.or(last_turn_id)?;
    if explicit_turn_id.is_some() {
        *unscoped_message = None;
        return Some((turn_id, provider_message_id));
    }

    let message_id = unscoped_message
        .filter(|(candidate_turn, _)| *candidate_turn == turn_id)
        .map(|(_, message_id)| message_id)
        .unwrap_or(provider_message_id);
    *unscoped_message = (!complete).then_some((turn_id, message_id));
    Some((turn_id, message_id))
}

/// The open segment must be the last row. Any tool, task launch, notice,
/// approval, or other assistant message closes it without changing its key.
fn tail_open_assistant<'a>(out: &'a mut [TranscriptEntry], id: MessageId, origin: &EventOrigin) -> Option<&'a mut TranscriptEntry> {
    let entry = out.last_mut()?;
    let is_match = matches!(
        &*entry,
        TranscriptEntry::Assistant {
            id: candidate,
            origin: candidate_origin,
            complete: false,
            ..
        } if *candidate == id && candidate_origin == origin
    );
    if is_match { Some(entry) } else { None }
}

fn next_segment(out: &[TranscriptEntry], id: MessageId, origin: &EventOrigin) -> u32 {
    out.iter()
        .filter_map(|entry| match entry {
            TranscriptEntry::Assistant { id: candidate, origin: candidate_origin, segment, .. }
                if *candidate == id && candidate_origin == origin =>
            {
                Some(*segment)
            }
            _ => None,
        })
        .max()
        .map_or(0, |segment| segment + 1)
}

fn assistant_segment_indices(out: &[TranscriptEntry], id: MessageId, origin: &EventOrigin) -> Vec<usize> {
    out.iter()
        .enumerate()
        .filter_map(|(index, entry)| {
            matches!(entry, TranscriptEntry::Assistant { id: candidate, origin: candidate_origin, .. } if *candidate == id && candidate_origin == origin)
                .then_some(index)
        })
        .collect()
}

#[derive(Clone, Copy)]
enum AssistantField {
    Text,
    Thinking,
}

fn assistant_field(entry: &TranscriptEntry, field: AssistantField) -> &str {
    match (entry, field) {
        (TranscriptEntry::Assistant { text, .. }, AssistantField::Text) => text,
        (TranscriptEntry::Assistant { thinking, .. }, AssistantField::Thinking) => thinking.as_deref().unwrap_or_default(),
        _ => "",
    }
}

/// Like canonical.strip_prefix(concatenated_segments), without constructing that
/// concatenation. The returned slice borrows only canonical, never the transcript.
fn assistant_field_suffix<'a>(out: &[TranscriptEntry], indices: &[usize], canonical: &'a str, field: AssistantField) -> Option<&'a str> {
    let mut remaining = canonical;
    for &index in indices {
        remaining = remaining.strip_prefix(assistant_field(&out[index], field))?;
    }
    Some(remaining)
}

/// Reconcile streamed slices with the provider's authoritative completed message.
/// Compare borrowed text; allocate only the replacement segment. Unchanged prefix
/// strings stay in place and obsolete tails are dropped, not kept as empty buffers.
fn reconcile_assistant_field(out: &mut [TranscriptEntry], indices: &[usize], canonical: &str, field: AssistantField) {
    if indices.is_empty() || assistant_field_suffix(out, indices, canonical, field) == Some("") {
        return;
    }
    let streamed_len = indices.iter().map(|&index| assistant_field(&out[index], field).len()).sum::<usize>();
    let common_prefix = indices
        .iter()
        .flat_map(|&index| assistant_field(&out[index], field).chars())
        .zip(canonical.chars())
        .take_while(|(left, right)| left == right)
        .map(|(ch, _)| ch.len_utf8())
        .sum::<usize>();
    let target_position = if streamed_len == 0 {
        if matches!(field, AssistantField::Thinking) { 0 } else { indices.len() - 1 }
    } else {
        let mut consumed = 0;
        indices
            .iter()
            .position(|&index| {
                let len = assistant_field(&out[index], field).len();
                let contains = common_prefix < consumed + len;
                consumed += len;
                contains
            })
            .unwrap_or(indices.len() - 1)
    };
    let consumed_before = indices.iter().take(target_position).map(|&index| assistant_field(&out[index], field).len()).sum::<usize>();
    let piece = assistant_field(&out[indices[target_position]], field);
    let keep = common_prefix.saturating_sub(consumed_before).min(piece.len());
    let suffix = &canonical[common_prefix..];
    let mut replacement = String::with_capacity(keep + suffix.len());
    replacement.push_str(&piece[..keep]);
    replacement.push_str(suffix);
    let mut replacement = Some(replacement);

    for (position, &index) in indices.iter().enumerate() {
        if let TranscriptEntry::Assistant { text, thinking, .. } = &mut out[index] {
            if position < target_position {
                // The old reconciliation normalized empty thinking to None.
                if matches!(field, AssistantField::Thinking) && thinking.as_ref().is_some_and(String::is_empty) {
                    *thinking = None;
                }
                continue;
            }
            let value = if position == target_position { replacement.take().unwrap_or_default() } else { String::new() };
            match field {
                AssistantField::Text => *text = value,
                AssistantField::Thinking => *thinking = (!value.is_empty()).then_some(value),
            }
        }
    }
}

fn mark_turn_complete(out: &mut [TranscriptEntry], turn: TurnId) {
    for e in out.iter_mut() {
        match e {
            TranscriptEntry::Assistant { turn_id, complete, .. } if *turn_id == turn => *complete = true,
            TranscriptEntry::ToolCall { turn_id, complete, output, .. } if *turn_id == turn && !*complete => {
                *complete = true;
                if output.is_none() {
                    *output = Some(Value::Null);
                }
            }
            _ => {}
        }
    }
}

/// Fold sparse updates without erasing independently reported account limits.
pub fn project_provider_usage(events: &[ThreadEvent]) -> ProviderUsage {
    let mut result = ProviderUsage::default();
    for event in events {
        if let EventPayload::ProviderUsageUpdated { usage } = &event.payload {
            if usage.context.is_some() {
                result.context = usage.context.clone();
            }
            if let Some(limits) = &usage.limits {
                let current = result.limits.get_or_insert_default();
                for limit in limits {
                    if let Some(old) = current.iter_mut().find(|old| old.name == limit.name) {
                        old.used_percent = limit.used_percent;
                        old.window_minutes = limit.window_minutes.or(old.window_minutes);
                        old.resets_at = limit.resets_at.or(old.resets_at);
                    } else {
                        current.push(limit.clone());
                    }
                }
            }
        }
    }
    result
}

/// Async questions survive turn completion, session release, and client reload.
pub fn project_pending_questions(events: &[ThreadEvent]) -> Vec<AsyncQuestionRequest> {
    let mut requests = Vec::<AsyncQuestionRequest>::new();
    let mut answered = std::collections::HashSet::new();
    for event in events {
        match &event.payload {
            EventPayload::AsyncQuestionsRequested { request } => {
                if !answered.contains(&request.id) && !requests.iter().any(|r| r.id == request.id) {
                    requests.push(request.clone());
                }
            }
            EventPayload::AsyncQuestionsAnswered { request_id, .. } => {
                answered.insert(request_id.clone());
                requests.retain(|r| r.id != *request_id);
            }
            _ => {}
        }
    }
    requests
}

#[cfg(test)]
mod tests {
    use super::{project_runtime_tasks, project_thread_activity, project_transcript};
    use chrono::{Duration, TimeZone, Utc};
    use kybern_protocol::*;
    use uuid::Uuid;

    fn runtime_task(id: &str, kind: RuntimeTaskKind, status: RuntimeTaskStatus, offset_seconds: i64) -> RuntimeTask {
        let at = Utc.timestamp_opt(1_700_000_000, 0).single().unwrap() + Duration::seconds(offset_seconds);
        RuntimeTask {
            id: id.into(),
            thread_id: Uuid::from_u128(1),
            origin_turn_id: Uuid::from_u128(2),
            started_seq: 0,
            updated_seq: 0,
            kind,
            status,
            title: id.into(),
            detail: None,
            provider_type: None,
            parent_id: None,
            tool_call_id: None,
            provider_thread_id: None,
            model: None,
            effort: None,
            backgrounded: kind != RuntimeTaskKind::Agent,
            last_tool_name: None,
            usage: None,
            stats: RuntimeTaskStats::default(),
            capabilities: RuntimeTaskCapabilities::default(),
            started_at: at,
            updated_at: at,
            completed_at: (!status.is_active()).then_some(at),
        }
    }

    fn event(seq: EventSeq, task: RuntimeTask, payload: fn(RuntimeTask) -> EventPayload) -> ThreadEvent {
        ThreadEvent { seq, thread_id: task.thread_id, turn_id: Some(task.origin_turn_id), at: task.updated_at, payload: payload(task) }
    }

    #[test]
    fn historical_root_as_child_is_hidden_even_when_binding_arrived_later() {
        let mut phantom = runtime_task("root", RuntimeTaskKind::Agent, RuntimeTaskStatus::Waiting, 0);
        phantom.provider_thread_id = Some("root-session".into());
        let mut child = runtime_task("child", RuntimeTaskKind::Agent, RuntimeTaskStatus::Running, 1);
        child.provider_thread_id = Some("child-session".into());
        let mut process = runtime_task("process", RuntimeTaskKind::Process, RuntimeTaskStatus::Running, 2);
        process.provider_thread_id = Some("root-session".into());
        let events = vec![
            event(1, phantom.clone(), |task| EventPayload::RuntimeTaskStarted { task }),
            ThreadEvent {
                seq: 2,
                thread_id: phantom.thread_id,
                turn_id: Some(phantom.origin_turn_id),
                at: phantom.updated_at,
                payload: EventPayload::ProviderSessionBound { session_id: "root-session".into(), model: None },
            },
            event(3, child, |task| EventPayload::RuntimeTaskStarted { task }),
            event(4, process, |task| EventPayload::RuntimeTaskStarted { task }),
            event(5, phantom, |task| EventPayload::RuntimeTaskUpdated { task }),
        ];
        let reloaded: Vec<ThreadEvent> = serde_json::from_str(&serde_json::to_string(&events).unwrap()).unwrap();
        let tasks = project_runtime_tasks(&reloaded);
        assert_eq!(tasks.iter().map(|task| task.id.as_str()).collect::<Vec<_>>(), ["child", "process"]);
        let rows = project_transcript(&reloaded);
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|row| matches!(row, TranscriptEntry::RuntimeTask { task, .. } if task.id != "root")));
        // Without a root binding, unknown agents must be retained.
        let unbound: Vec<_> =
            reloaded.into_iter().filter(|event| !matches!(event.payload, EventPayload::ProviderSessionBound { .. })).collect();
        assert_eq!(project_runtime_tasks(&unbound).len(), 3);
    }

    #[test]
    fn native_images_reload_once_per_turn_and_keep_the_original_source() {
        let thread_id = Uuid::new_v4();
        let turn_id = Uuid::new_v4();
        let image =
            EventPayload::ImageReceived { id: "image".into(), origin: EventOrigin::Root, source: "data:image/png;base64,YQ==".into() };
        let events = [1, 2].map(|seq| ThreadEvent { seq, thread_id, turn_id: Some(turn_id), at: Utc::now(), payload: image.clone() });
        let serialized = serde_json::to_string(&events).unwrap();
        let reloaded: Vec<ThreadEvent> = serde_json::from_str(&serialized).unwrap();
        let rows = project_transcript(&reloaded);
        assert_eq!(rows.len(), 1);
        assert!(
            matches!(&rows[0], TranscriptEntry::Image { source, turn_id: row_turn, .. } if source == "data:image/png;base64,YQ==" && *row_turn == turn_id)
        );
    }

    #[test]
    fn runtime_projection_keeps_latest_snapshot_and_sorts_active_work_first() {
        let started_agent = runtime_task("agent", RuntimeTaskKind::Agent, RuntimeTaskStatus::Running, 0);
        let completed_agent = runtime_task("agent", RuntimeTaskKind::Agent, RuntimeTaskStatus::Completed, 5);
        let stale_agent = runtime_task("agent", RuntimeTaskKind::Agent, RuntimeTaskStatus::Running, 2);
        let tied_agent = runtime_task("agent", RuntimeTaskKind::Agent, RuntimeTaskStatus::Running, 5);
        let process = runtime_task("process", RuntimeTaskKind::Process, RuntimeTaskStatus::Running, 3);
        let mut monitor = runtime_task("monitor", RuntimeTaskKind::Monitor, RuntimeTaskStatus::Waiting, 1);
        monitor.parent_id = Some("process".into());
        let events = vec![
            event(1, started_agent, |task| EventPayload::RuntimeTaskStarted { task }),
            event(2, process, |task| EventPayload::RuntimeTaskStarted { task }),
            event(3, monitor, |task| EventPayload::RuntimeTaskUpdated { task }),
            event(4, completed_agent, |task| EventPayload::RuntimeTaskCompleted { task }),
            // A delayed progress frame must not resurrect terminal work.
            event(5, stale_agent, |task| EventPayload::RuntimeTaskUpdated { task }),
            event(6, tied_agent, |task| EventPayload::RuntimeTaskUpdated { task }),
        ];

        let tasks = project_runtime_tasks(&events);
        assert_eq!(tasks.iter().map(|task| task.id.as_str()).collect::<Vec<_>>(), ["process", "monitor", "agent"]);
        assert_eq!(tasks.iter().filter(|task| task.id == "agent").count(), 1);
        assert_eq!(tasks[2].status, RuntimeTaskStatus::Completed);
        assert_eq!(
            project_transcript(&events)
                .iter()
                .filter_map(|row| match row {
                    TranscriptEntry::RuntimeTask { seq, task, .. } => Some((*seq, task.id.as_str(), task.status)),
                    _ => None,
                })
                .collect::<Vec<_>>(),
            [
                (1, "agent", RuntimeTaskStatus::Completed),
                (2, "process", RuntimeTaskStatus::Running),
                (3, "monitor", RuntimeTaskStatus::Waiting)
            ]
        );

        let summary = project_thread_activity(Uuid::from_u128(1), &tasks);
        assert_eq!(summary.state, Some(ThreadActivityState::Monitoring));
        assert_eq!(summary.active_agents, 0);
        assert_eq!(summary.active_processes, 1);
        assert_eq!(summary.active_monitors, 1);
    }

    #[test]
    fn runtime_projection_reactivates_only_an_explicitly_restarted_agent() {
        let running = runtime_task("agent", RuntimeTaskKind::Agent, RuntimeTaskStatus::Running, 0);
        let completed = runtime_task("agent", RuntimeTaskKind::Agent, RuntimeTaskStatus::Completed, 1);
        let delayed = runtime_task("agent", RuntimeTaskKind::Agent, RuntimeTaskStatus::Running, 2);
        let resumed = runtime_task("agent", RuntimeTaskKind::Agent, RuntimeTaskStatus::Running, 3);
        let failed = runtime_task("agent", RuntimeTaskKind::Agent, RuntimeTaskStatus::Failed, 4);
        let events = vec![
            event(1, running, |task| EventPayload::RuntimeTaskStarted { task }),
            event(2, completed, |task| EventPayload::RuntimeTaskCompleted { task }),
            event(3, delayed, |task| EventPayload::RuntimeTaskUpdated { task }),
        ];
        let settled = project_runtime_tasks(&events);
        assert_eq!(settled[0].status, RuntimeTaskStatus::Completed);
        assert_eq!(project_thread_activity(Uuid::from_u128(1), &settled).active_agents, 0);

        let mut reused = events;
        reused.push(event(4, resumed, |task| EventPayload::RuntimeTaskStarted { task }));
        let active = project_runtime_tasks(&reused);
        assert_eq!(active[0].status, RuntimeTaskStatus::Running);
        assert_eq!(project_thread_activity(Uuid::from_u128(1), &active).active_agents, 1);

        reused.push(event(5, failed, |task| EventPayload::RuntimeTaskCompleted { task }));
        let failed = project_runtime_tasks(&reused);
        assert_eq!(failed[0].status, RuntimeTaskStatus::Failed);
        assert_eq!(project_thread_activity(Uuid::from_u128(1), &failed).active_agents, 0);

        reused.push(event(6, runtime_task("agent", RuntimeTaskKind::Agent, RuntimeTaskStatus::Running, 5), |task| {
            EventPayload::RuntimeTaskStarted { task }
        }));
        reused.push(event(7, runtime_task("agent", RuntimeTaskKind::Agent, RuntimeTaskStatus::Interrupted, 6), |task| {
            EventPayload::RuntimeTaskCompleted { task }
        }));
        let interrupted = project_runtime_tasks(&reused);
        assert_eq!(interrupted[0].status, RuntimeTaskStatus::Interrupted);
        assert_eq!(project_thread_activity(Uuid::from_u128(1), &interrupted).active_agents, 0);
    }

    #[test]
    fn assistant_text_interleaved_with_a_tool_keeps_ordered_segments() {
        let thread_id = Uuid::from_u128(1);
        let turn_id = Uuid::from_u128(2);
        let message_id = Uuid::from_u128(3);
        let at = Utc.timestamp_opt(1_700_000_000, 0).single().unwrap();
        let ev = |seq, payload| ThreadEvent { seq, thread_id, turn_id: Some(turn_id), at, payload };
        let tool = ToolCall { id: "call-1".into(), name: "bash".into(), input: serde_json::Value::Null, parent_id: None };

        // One message id spans preamble → tool → answer (Claude's interleaving).
        let events = vec![
            ev(1, EventPayload::AssistantTextDelta { message_id, origin: EventOrigin::Root, delta: "Let me look. ".into() }),
            ev(2, EventPayload::ToolCallStarted { call: tool.clone(), origin: EventOrigin::Root }),
            ev(
                3,
                EventPayload::ToolCallCompleted {
                    tool_call_id: "call-1".into(),
                    output: serde_json::Value::Null,
                    output_omitted: false,
                    is_error: false,
                },
            ),
            ev(4, EventPayload::AssistantTextDelta { message_id, origin: EventOrigin::Root, delta: "Here is the answer.".into() }),
            ev(
                5,
                EventPayload::AssistantMessageCompleted {
                    message_id,
                    origin: EventOrigin::Root,
                    text: "Let me look. Here is the answer.".into(),
                    thinking: None,
                },
            ),
        ];

        let rendered: Vec<String> = project_transcript(&events)
            .iter()
            .map(|e| match e {
                TranscriptEntry::Assistant { seq, segment, text, complete, .. } => format!("assistant:{seq}:{segment}:{text}:{complete}"),
                TranscriptEntry::ToolCall { call, .. } => format!("tool:{}", call.id),
                _ => "other".into(),
            })
            .collect();

        assert_eq!(rendered, vec!["assistant:1:0:Let me look. :true", "tool:call-1", "assistant:4:1:Here is the answer.:true"]);
    }

    #[test]
    fn completion_only_suffix_after_a_tool_gets_its_own_sequence_row() {
        let thread_id = Uuid::from_u128(1);
        let turn_id = Uuid::from_u128(2);
        let message_id = Uuid::from_u128(3);
        let at = Utc.timestamp_opt(1_700_000_000, 0).single().unwrap();
        let ev = |seq, payload| ThreadEvent { seq, thread_id, turn_id: Some(turn_id), at, payload };
        let events = vec![
            ev(1, EventPayload::AssistantTextDelta { message_id, origin: EventOrigin::Root, delta: "I will inspect. ".into() }),
            ev(
                2,
                EventPayload::ToolCallStarted {
                    call: ToolCall { id: "call-1".into(), name: "read".into(), input: serde_json::Value::Null, parent_id: None },
                    origin: EventOrigin::Root,
                },
            ),
            ev(
                3,
                EventPayload::ToolCallCompleted {
                    tool_call_id: "call-1".into(),
                    output: serde_json::Value::Null,
                    output_omitted: false,
                    is_error: false,
                },
            ),
            ev(
                4,
                EventPayload::AssistantMessageCompleted {
                    message_id,
                    origin: EventOrigin::Root,
                    text: "I will inspect. Found it.".into(),
                    thinking: None,
                },
            ),
        ];

        let rows = project_transcript(&events);
        let assistant = rows
            .iter()
            .filter_map(|row| match row {
                TranscriptEntry::Assistant { seq, segment, text, .. } => Some((*seq, *segment, text.as_str())),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(assistant, [(1, 0, "I will inspect. "), (4, 1, "Found it.")]);
    }

    #[test]
    fn reload_recovers_a_claude_continuation_emitted_after_a_provisional_result() {
        let events: Vec<ThreadEvent> =
            serde_json::from_str(include_str!("../../../fixtures/transcript/claude-background-continuation.json"))
                .expect("valid captured fixture");
        let turn_id = Uuid::from_u128(0x12);
        let final_text = "Both subagents are back — this is the final answer.";

        let rows = project_transcript(&events);
        let assistant = rows
            .iter()
            .filter_map(|row| match row {
                TranscriptEntry::Assistant { id, turn_id: row_turn_id, text, .. } => Some((*id, *row_turn_id, text.as_str())),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(assistant.len(), 2);
        assert_eq!(assistant[0].1, turn_id);
        assert_eq!(assistant[0].2, "Holding for the last agent.");
        assert_eq!(assistant[1].1, turn_id);
        assert_eq!(assistant[1].2, final_text);
    }

    #[test]
    fn resumed_process_has_one_summary_and_preserves_tools_on_reload() {
        let events: Vec<ThreadEvent> =
            serde_json::from_str(include_str!("../../../fixtures/transcript/claude-process-resumed.json")).unwrap();
        let live = project_transcript(&events[..6]);
        assert!(!live.iter().any(|entry| matches!(entry, TranscriptEntry::TurnSummary { .. })));
        let rows = project_transcript(&events);
        assert_eq!(rows.iter().filter(|entry| matches!(entry, TranscriptEntry::User { .. })).count(), 1);
        assert_eq!(rows.iter().filter(|entry| matches!(entry, TranscriptEntry::ToolCall { .. })).count(), 1);
        let summaries = rows
            .iter()
            .filter_map(|entry| match entry {
                TranscriptEntry::TurnSummary { usage, terminal_message_id, .. } => Some((usage, terminal_message_id)),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].0.input_tokens, 3);
        assert_eq!(*summaries[0].1, Some(Uuid::parse_str("00000000-0000-0000-0000-000000000015").unwrap()));

        // Older daemon shape: no resume/final completion event, and orphaned
        // follow-up tools/text. Reload must retain those tools and stop pinning
        // the obsolete foreground answer.
        let historical = events[..11]
            .iter()
            .filter(|event| !matches!(event.payload, EventPayload::TurnResumed))
            .cloned()
            .map(|mut event| {
                if event.seq > 6 {
                    event.turn_id = None;
                }
                event
            })
            .collect::<Vec<_>>();
        let rows = project_transcript(&historical);
        assert_eq!(rows.iter().filter(|entry| matches!(entry, TranscriptEntry::ToolCall { .. })).count(), 1);
        assert!(rows.iter().any(|entry| matches!(entry, TranscriptEntry::TurnSummary { terminal_message_id: None, .. })));
    }

    #[test]
    fn captured_mixed_agent_turn_has_the_same_reload_projection() {
        let events: Vec<ThreadEvent> =
            serde_json::from_str(include_str!("../../../fixtures/transcript/codex-mixed-agent-turn.json")).expect("valid captured fixture");
        let signature = project_transcript(&events)
            .iter()
            .map(|row| match row {
                TranscriptEntry::User { seq, .. } => format!("user:{seq}"),
                TranscriptEntry::Assistant { seq, text, .. } => format!("assistant:{seq}:{text}"),
                TranscriptEntry::ToolCall { seq, call, .. } => format!("tool:{seq}:{}", call.id),
                TranscriptEntry::RuntimeTask { seq, task, .. } => format!("task:{seq}:{}:{:?}", task.id, task.status),
                TranscriptEntry::TurnSummary { seq, .. } => format!("end:{seq}"),
                other => format!("other:{other:?}"),
            })
            .collect::<Vec<_>>();
        assert_eq!(
            signature,
            [
                "user:1",
                "assistant:2:I’ll inspect the renderer first.",
                "tool:4:root-read",
                "tool:6:agent-call",
                "task:7:agent-task:Completed",
                "tool:8:child-search",
                "task:12:native-agent:Completed",
                "assistant:13:The ordered transcript is ready.",
                "end:15",
            ]
        );

        let tasks = project_runtime_tasks(&events);
        assert_eq!(
            tasks.iter().map(|task| (task.id.as_str(), task.started_seq, task.updated_seq)).collect::<Vec<_>>(),
            [("native-agent", 12, 18), ("agent-task", 7, 17),]
        );
    }

    #[test]
    fn large_settled_tool_results_are_omitted_from_the_cached_projection() {
        let thread_id = Uuid::from_u128(1);
        let turn_id = Uuid::from_u128(2);
        let at = Utc.timestamp_opt(1_700_000_000, 0).single().unwrap();
        let ev = |seq, payload| ThreadEvent { seq, thread_id, turn_id: Some(turn_id), at, payload };
        let small = serde_json::json!("ok");
        let large = serde_json::json!("x".repeat(super::LARGE_TOOL_OUTPUT_BYTES + 1));
        let events = [
            ev(1, EventPayload::TurnStarted { message_id: Uuid::from_u128(3), message: UserMessage::text("hi") }),
            ev(
                2,
                EventPayload::ToolCallStarted {
                    call: ToolCall { id: "small".into(), name: "bash".into(), input: serde_json::Value::Null, parent_id: None },
                    origin: EventOrigin::Root,
                },
            ),
            ev(
                3,
                EventPayload::ToolCallCompleted {
                    tool_call_id: "small".into(),
                    output: small.clone(),
                    output_omitted: false,
                    is_error: false,
                },
            ),
            ev(
                4,
                EventPayload::ToolCallStarted {
                    call: ToolCall { id: "large".into(), name: "bash".into(), input: serde_json::Value::Null, parent_id: None },
                    origin: EventOrigin::Root,
                },
            ),
            ev(
                5,
                EventPayload::ToolCallCompleted {
                    tool_call_id: "large".into(),
                    output: large.clone(),
                    output_omitted: false,
                    is_error: false,
                },
            ),
        ];
        let full = project_transcript(&events);
        assert!(
            matches!(full.last(), Some(TranscriptEntry::ToolCall { output: Some(value), output_omitted: false, .. }) if value == &large)
        );
        let mut fold = super::TranscriptFold::omitting_tool_outputs();
        for event in &events {
            fold.apply(event);
        }
        let rows = fold.finish();
        let tools: Vec<_> = rows
            .iter()
            .filter_map(|row| match row {
                TranscriptEntry::ToolCall { call, output, output_omitted, .. } => Some((call.id.as_str(), output.clone(), *output_omitted)),
                _ => None,
            })
            .collect();
        assert_eq!(tools, vec![("small", Some(small), false), ("large", None, true)]);
    }

    #[test]
    fn json_payload_size_counts_structure_and_escaping() {
        let structured = serde_json::Value::Array(vec![serde_json::Value::Array(Vec::new()); 1024]);
        assert!(super::should_omit_tool_output(&structured));

        let escaped = serde_json::json!({ "text\n": "\\\"\n".repeat(512) });
        assert!(super::json_payload_bytes(&escaped) > escaped.to_string().len() - 1);
        assert!(super::should_omit_tool_output(&escaped));

        let at_limit = serde_json::Value::String("x".repeat(super::LARGE_TOOL_OUTPUT_BYTES - 2));
        assert_eq!(super::json_payload_bytes(&at_limit), super::LARGE_TOOL_OUTPUT_BYTES);
        assert!(!super::should_omit_tool_output(&at_limit));
        let over_limit = serde_json::Value::String("x".repeat(super::LARGE_TOOL_OUTPUT_BYTES - 1));
        assert_eq!(super::json_payload_bytes(&over_limit), super::LARGE_TOOL_OUTPUT_BYTES + 1);
        assert!(super::should_omit_tool_output(&over_limit));
    }

    #[test]
    fn active_agent_promotes_thread_activity_to_working() {
        let tasks = vec![
            runtime_task("monitor", RuntimeTaskKind::Monitor, RuntimeTaskStatus::Waiting, 0),
            runtime_task("agent", RuntimeTaskKind::Agent, RuntimeTaskStatus::Running, 1),
        ];

        let summary = project_thread_activity(Uuid::from_u128(1), &tasks);
        assert_eq!(summary.state, Some(ThreadActivityState::Working));
        assert_eq!(summary.active_agents, 1);
        assert_eq!(summary.active_monitors, 1);
    }
}

#[cfg(test)]
mod reconciliation_allocation_tests {
    use super::*;

    fn assistant_field_text(out: &[TranscriptEntry], indices: &[usize], field: AssistantField) -> String {
        indices
            .iter()
            .map(|index| match (&out[*index], field) {
                (TranscriptEntry::Assistant { text, .. }, AssistantField::Text) => text.as_str(),
                (TranscriptEntry::Assistant { thinking, .. }, AssistantField::Thinking) => thinking.as_deref().unwrap_or_default(),
                _ => "",
            })
            .collect()
    }

    /// Reconcile streamed slices with the provider's authoritative completed
    /// message while preserving every segment boundary that preceded a tool row.
    fn legacy_reconcile_assistant_field(out: &mut [TranscriptEntry], indices: &[usize], canonical: &str, field: AssistantField) {
        let pieces = indices
            .iter()
            .map(|index| match (&out[*index], field) {
                (TranscriptEntry::Assistant { text, .. }, AssistantField::Text) => text.clone(),
                (TranscriptEntry::Assistant { thinking, .. }, AssistantField::Thinking) => thinking.clone().unwrap_or_default(),
                _ => String::new(),
            })
            .collect::<Vec<_>>();
        let streamed = pieces.concat();
        if streamed == canonical {
            return;
        }

        let common_prefix =
            streamed.chars().zip(canonical.chars()).take_while(|(left, right)| left == right).map(|(ch, _)| ch.len_utf8()).sum::<usize>();
        let target_position = if streamed.is_empty() {
            if matches!(field, AssistantField::Thinking) { 0 } else { indices.len() - 1 }
        } else {
            let mut consumed = 0;
            pieces
                .iter()
                .position(|piece| {
                    let contains = common_prefix < consumed + piece.len();
                    consumed += piece.len();
                    contains
                })
                .unwrap_or(indices.len() - 1)
        };
        let consumed_before = pieces.iter().take(target_position).map(String::len).sum::<usize>();
        let keep = common_prefix.saturating_sub(consumed_before).min(pieces[target_position].len());
        let mut replacement = pieces[target_position][..keep].to_string();
        replacement.push_str(&canonical[common_prefix..]);

        for (position, index) in indices.iter().enumerate() {
            let value = if position < target_position {
                pieces[position].clone()
            } else if position == target_position {
                replacement.clone()
            } else {
                String::new()
            };
            if let TranscriptEntry::Assistant { text, thinking, .. } = &mut out[*index] {
                match field {
                    AssistantField::Text => *text = value,
                    AssistantField::Thinking => *thinking = (!value.is_empty()).then_some(value),
                }
            }
        }
    }

    fn rows(pieces: &[Option<&str>]) -> (Vec<TranscriptEntry>, Vec<usize>) {
        let mut out = Vec::new();
        let mut indices = Vec::new();
        for (segment, piece) in pieces.iter().enumerate() {
            indices.push(out.len());
            out.push(TranscriptEntry::Assistant {
                id: MessageId::nil(),
                turn_id: TurnId::nil(),
                seq: segment as i64 + 1,
                origin: Default::default(),
                segment: segment as u32,
                text: piece.unwrap_or_default().into(),
                thinking: piece.map(str::to_owned),
                at: "2026-09-17T00:00:00Z".parse().unwrap(),
                complete: false,
            });
            out.push(TranscriptEntry::Notice {
                turn_id: TurnId::nil(),
                seq: segment as i64 + 1,
                level: NoticeLevel::Info,
                text: "separator".into(),
                at: "2026-09-17T00:00:00Z".parse().unwrap(),
            });
        }
        (out, indices)
    }

    #[test]
    fn borrowed_reconciliation_matches_legacy_for_unicode_and_segment_boundaries() {
        let pieces = [None, Some(""), Some("a"), Some("ab"), Some("é"), Some("😀"), Some("e\u{301}"), Some("\n\0")];
        let canonical = ["", "a", "ab", "abc", "ba", "é", "éa", "😀", "😀é", "e\u{301}", "\u{301}", "\n\0", "ab\n\0tail"];
        for a in pieces {
            for b in pieces {
                for c in pieces {
                    for parts in [vec![a], vec![a, b], vec![a, b, c]] {
                        let (source, indices) = rows(&parts);
                        for text in canonical {
                            for field in [AssistantField::Text, AssistantField::Thinking] {
                                let expected_suffix = text.strip_prefix(&assistant_field_text(&source, &indices, field));
                                assert_eq!(assistant_field_suffix(&source, &indices, text, field), expected_suffix);
                                let mut expected = source.clone();
                                let mut actual = source.clone();
                                legacy_reconcile_assistant_field(&mut expected, &indices, text, field);
                                reconcile_assistant_field(&mut actual, &indices, text, field);
                                assert_eq!(
                                    serde_json::to_value(&actual).unwrap(),
                                    serde_json::to_value(&expected).unwrap(),
                                    "parts={parts:?}, canonical={text:?}"
                                );
                            }
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn correction_keeps_prefix_string_and_frees_obsolete_tail() {
        let (mut out, indices) = rows(&[Some("keep "), Some("wrong "), Some("old tail")]);
        let pointer = match &out[indices[0]] {
            TranscriptEntry::Assistant { text, .. } => text.as_ptr(),
            _ => unreachable!(),
        };
        reconcile_assistant_field(&mut out, &indices, "keep corrected", AssistantField::Text);
        let TranscriptEntry::Assistant { text, .. } = &out[indices[0]] else { unreachable!() };
        assert_eq!(text.as_ptr(), pointer);
        assert_eq!(text, "keep ");
        let TranscriptEntry::Assistant { text, .. } = &out[indices[1]] else { unreachable!() };
        assert_eq!(text, "corrected");
        let TranscriptEntry::Assistant { text, .. } = &out[indices[2]] else { unreachable!() };
        assert_eq!(text.capacity(), 0);
    }

    #[test]
    fn empty_indices_are_a_noop() {
        let (mut out, _) = rows(&[Some("unchanged")]);
        let before = serde_json::to_value(&out).unwrap();
        reconcile_assistant_field(&mut out, &[], "replacement", AssistantField::Text);
        assert_eq!(serde_json::to_value(&out).unwrap(), before);
    }
}
