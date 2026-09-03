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
        match tasks.entry(task.id.clone()) {
            Entry::Vacant(entry) => {
                entry.insert(task.clone());
            }
            Entry::Occupied(mut entry) => {
                let current = entry.get();
                let newer = task.updated_at > current.updated_at;
                let tied_and_not_regressing =
                    task.updated_at == current.updated_at && (current.status.is_active() || !task.status.is_active());
                if newer || tied_and_not_regressing {
                    entry.insert(task.clone());
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
                right.updated_at.cmp(&left.updated_at).then_with(|| left.id.cmp(&right.id))
            } else {
                left.started_at.cmp(&right.started_at).then_with(|| left.id.cmp(&right.id))
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
    remaining.sort_by(|left, right| left.started_at.cmp(&right.started_at).then_with(|| left.id.cmp(&right.id)));
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

    for ev in events {
        let turn_id = ev.turn_id;
        match &ev.payload {
            EventPayload::TurnStarted { message_id, message } => {
                let Some(turn_id) = turn_id else { continue };
                turn_started_at.insert(turn_id, ev.at);
                out.push(TranscriptEntry::User { id: *message_id, turn_id, message: message.clone(), at: ev.at });
            }
            EventPayload::AssistantTextDelta { message_id, delta } => {
                let Some(turn_id) = turn_id else { continue };
                match find_assistant(&mut out, *message_id) {
                    Some(TranscriptEntry::Assistant { text, .. }) => text.push_str(delta),
                    _ => out.push(TranscriptEntry::Assistant {
                        id: *message_id,
                        turn_id,
                        text: delta.clone(),
                        thinking: None,
                        at: ev.at,
                        complete: false,
                    }),
                }
            }
            EventPayload::AssistantThinkingDelta { message_id, delta } => {
                let Some(turn_id) = turn_id else { continue };
                match find_assistant(&mut out, *message_id) {
                    Some(TranscriptEntry::Assistant { thinking, .. }) => thinking.get_or_insert_with(String::new).push_str(delta),
                    _ => out.push(TranscriptEntry::Assistant {
                        id: *message_id,
                        turn_id,
                        text: String::new(),
                        thinking: Some(delta.clone()),
                        at: ev.at,
                        complete: false,
                    }),
                }
            }
            EventPayload::AssistantMessageCompleted { message_id, text, thinking } => {
                let Some(turn_id) = turn_id else { continue };
                match find_assistant(&mut out, *message_id) {
                    Some(TranscriptEntry::Assistant { text: t, thinking: th, complete, .. }) => {
                        *t = text.clone();
                        if thinking.is_some() {
                            *th = thinking.clone();
                        }
                        *complete = true;
                    }
                    _ => out.push(TranscriptEntry::Assistant {
                        id: *message_id,
                        turn_id,
                        text: text.clone(),
                        thinking: thinking.clone(),
                        at: ev.at,
                        complete: true,
                    }),
                }
            }
            EventPayload::ToolCallStarted { call } => {
                let Some(turn_id) = turn_id else { continue };
                out.push(TranscriptEntry::ToolCall {
                    turn_id,
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
            EventPayload::TurnCompleted { stop_reason, usage, cost_usd, duration_ms } => {
                let Some(turn_id) = turn_id else { continue };
                mark_turn_complete(&mut out, turn_id);
                out.push(TranscriptEntry::TurnSummary {
                    turn_id,
                    stop_reason: *stop_reason,
                    usage: usage.clone(),
                    cost_usd: *cost_usd,
                    duration_ms: *duration_ms,
                    error: None,
                });
            }
            EventPayload::TurnFailed { error } => {
                let Some(turn_id) = turn_id else { continue };
                mark_turn_complete(&mut out, turn_id);
                let duration_ms = turn_started_at.get(&turn_id).map(|s| (ev.at - *s).num_milliseconds().max(0) as u64).unwrap_or(0);
                out.push(TranscriptEntry::TurnSummary {
                    turn_id,
                    stop_reason: StopReason::Error,
                    usage: Usage::default(),
                    cost_usd: None,
                    duration_ms,
                    error: Some(error.clone()),
                });
            }
            EventPayload::ApprovalRequested { approval } => {
                let Some(turn_id) = turn_id else { continue };
                out.push(TranscriptEntry::Approval { turn_id, approval: approval.clone(), decision: None });
            }
            EventPayload::ApprovalResolved { approval_id, decision } => {
                if let Some(TranscriptEntry::Approval { decision: d, .. }) =
                    out.iter_mut().rev().find(|e| matches!(e, TranscriptEntry::Approval { approval, .. } if approval.id == *approval_id))
                {
                    *d = Some(decision.clone());
                }
            }
            EventPayload::ThreadCreated { .. }
            | EventPayload::ThreadUpdated { .. }
            | EventPayload::ThreadArchived
            | EventPayload::ProviderSessionBound { .. }
            | EventPayload::ProviderNotice { .. }
            | EventPayload::RuntimeTaskStarted { .. }
            | EventPayload::RuntimeTaskUpdated { .. }
            | EventPayload::RuntimeTaskCompleted { .. }
            | EventPayload::ToolCallOutputDelta { .. }
            | EventPayload::CheckpointUpdated { .. }
            | EventPayload::WorkspaceReverted { .. } => {}
        }
    }
    out
}

fn find_assistant(out: &mut [TranscriptEntry], id: MessageId) -> Option<&mut TranscriptEntry> {
    out.iter_mut().rev().find(|e| matches!(e, TranscriptEntry::Assistant { id: i, .. } if *i == id))
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
        assert!(project_transcript(&events).is_empty());

        let summary = project_thread_activity(Uuid::from_u128(1), &tasks);
        assert_eq!(summary.state, Some(ThreadActivityState::Monitoring));
        assert_eq!(summary.active_agents, 0);
        assert_eq!(summary.active_processes, 1);
        assert_eq!(summary.active_monitors, 1);
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
