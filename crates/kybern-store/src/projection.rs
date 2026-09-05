//! Fold a thread's event log into the transcript clients render.

use kybern_protocol::*;
use serde_json::Value;

/// Fold append-only runtime task events into one latest-state row per task.
pub fn project_runtime_tasks(events: &[ThreadEvent]) -> Vec<RuntimeTask> {
    use std::collections::hash_map::Entry;

    let mut tasks = std::collections::HashMap::<String, RuntimeTask>::new();
    for event in events {
        let task = match &event.payload {
            EventPayload::RuntimeTaskStarted { task }
            | EventPayload::RuntimeTaskUpdated { task }
            | EventPayload::RuntimeTaskCompleted { task } => task,
            _ => continue,
        };
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
                let terminal_regression = !current.status.is_active() && task.status.is_active();
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
    let mut out: Vec<TranscriptEntry> = Vec::new();
    let mut turn_started_at = std::collections::HashMap::new();
    let mut last_turn_id = None;
    let mut unscoped_assistant_message = None;

    for ev in events {
        let turn_id = ev.turn_id;
        match &ev.payload {
            EventPayload::TurnStarted { message_id, message } => {
                let Some(turn_id) = turn_id else { continue };
                last_turn_id = Some(turn_id);
                unscoped_assistant_message = None;
                turn_started_at.insert(turn_id, ev.at);
                out.push(TranscriptEntry::User { id: *message_id, turn_id, seq: ev.seq, message: message.clone(), at: ev.at });
            }
            EventPayload::AssistantTextDelta { message_id, origin, delta } => {
                if !origin.is_root() {
                    continue;
                }
                let Some((turn_id, message_id)) =
                    assistant_scope(turn_id, last_turn_id, *message_id, &mut unscoped_assistant_message, false)
                else {
                    continue;
                };
                // The completed event remains the canonical whole message. For
                // presentation, open a new stable segment whenever a row-making
                // event landed since the previous delta so tools and narration
                // keep exact event order without fragmenting the live DOM node.
                match tail_open_assistant(&mut out, message_id, origin) {
                    Some(TranscriptEntry::Assistant { text, .. }) => text.push_str(delta),
                    _ => {
                        let segment = next_segment(&out, message_id, origin);
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
                    assistant_scope(turn_id, last_turn_id, *message_id, &mut unscoped_assistant_message, false)
                else {
                    continue;
                };
                match tail_open_assistant(&mut out, message_id, origin) {
                    Some(TranscriptEntry::Assistant { thinking, .. }) => thinking.get_or_insert_with(String::new).push_str(delta),
                    _ => {
                        let segment = next_segment(&out, message_id, origin);
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
                    assistant_scope(turn_id, last_turn_id, *message_id, &mut unscoped_assistant_message, true)
                else {
                    continue;
                };
                let mut segments = assistant_segment_indices(&out, message_id, origin);
                if segments.is_empty() {
                    out.push(TranscriptEntry::Assistant {
                        id: message_id,
                        turn_id,
                        seq: ev.seq,
                        origin: origin.clone(),
                        segment: next_segment(&out, message_id, origin),
                        text: text.clone(),
                        thinking: thinking.clone(),
                        at: ev.at,
                        complete: true,
                    });
                } else {
                    let last_is_tail = segments.last().is_some_and(|index| *index + 1 == out.len());
                    let streamed_text = assistant_field_text(&out, &segments, AssistantField::Text);
                    let streamed_thinking = assistant_field_text(&out, &segments, AssistantField::Thinking);
                    let trailing_text =
                        (!last_is_tail).then(|| text.strip_prefix(&streamed_text)).flatten().filter(|suffix| !suffix.is_empty());
                    let trailing_thinking = (!last_is_tail)
                        .then(|| thinking.as_deref()?.strip_prefix(&streamed_thinking))
                        .flatten()
                        .filter(|suffix| !suffix.is_empty());
                    if trailing_text.is_some() || trailing_thinking.is_some() {
                        let segment = next_segment(&out, message_id, origin);
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
                    reconcile_assistant_field(&mut out, &segments, text, AssistantField::Text);
                    if let Some(thinking) = thinking {
                        reconcile_assistant_field(&mut out, &segments, thinking, AssistantField::Thinking);
                    }
                    for index in segments {
                        if let TranscriptEntry::Assistant { complete, .. } = &mut out[index] {
                            *complete = true;
                        }
                    }
                }
            }
            EventPayload::ToolCallStarted { call, origin } => {
                let Some(turn_id) = turn_id else { continue };
                out.push(TranscriptEntry::ToolCall {
                    turn_id,
                    seq: ev.seq,
                    origin: origin.clone(),
                    call: call.clone(),
                    output: None,
                    is_error: false,
                    complete: false,
                    at: ev.at,
                });
            }
            EventPayload::ToolCallCompleted { tool_call_id, output, is_error } => {
                if let Some(TranscriptEntry::ToolCall { output: o, is_error: e, complete, .. }) =
                    out.iter_mut().rev().find(|e| matches!(e, TranscriptEntry::ToolCall { call, .. } if &call.id == tool_call_id))
                {
                    *o = Some(output.clone());
                    *e = *is_error;
                    *complete = true;
                }
            }
            EventPayload::TurnCompleted { stop_reason, usage, cost_usd, duration_ms, terminal_message_id } => {
                let Some(turn_id) = turn_id else { continue };
                last_turn_id = Some(turn_id);
                mark_turn_complete(&mut out, turn_id);
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
                last_turn_id = Some(turn_id);
                mark_turn_complete(&mut out, turn_id);
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
            EventPayload::ApprovalRequested { approval } => {
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
                    if current.status.is_active() || !incoming.status.is_active() {
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
            EventPayload::ThreadCreated { .. }
            | EventPayload::ThreadUpdated { .. }
            | EventPayload::MessageQueued { .. }
            | EventPayload::MessageRemoved { .. }
            | EventPayload::ThreadArchived
            | EventPayload::ProviderSessionBound { .. }
            | EventPayload::ToolCallOutputDelta { .. }
            | EventPayload::CheckpointUpdated { .. } => {}
        }
    }
    out
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
fn reconcile_assistant_field(out: &mut [TranscriptEntry], indices: &[usize], canonical: &str, field: AssistantField) {
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
            ev(3, EventPayload::ToolCallCompleted { tool_call_id: "call-1".into(), output: serde_json::Value::Null, is_error: false }),
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
            ev(3, EventPayload::ToolCallCompleted { tool_call_id: "call-1".into(), output: serde_json::Value::Null, is_error: false }),
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
