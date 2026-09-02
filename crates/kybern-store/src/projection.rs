//! Fold a thread's event log into the transcript clients render.

use kybern_protocol::*;
use serde_json::Value;

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
                if let Some(TranscriptEntry::ToolCall { output: o, is_error: e, complete, .. }) = out
                    .iter_mut()
                    .rev()
                    .find(|e| matches!(e, TranscriptEntry::ToolCall { call, .. } if &call.id == tool_call_id))
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
                let duration_ms = turn_started_at
                    .get(&turn_id)
                    .map(|s| (ev.at - *s).num_milliseconds().max(0) as u64)
                    .unwrap_or(0);
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
                if let Some(TranscriptEntry::Approval { decision: d, .. }) = out
                    .iter_mut()
                    .rev()
                    .find(|e| matches!(e, TranscriptEntry::Approval { approval, .. } if approval.id == *approval_id))
                {
                    *d = Some(decision.clone());
                }
            }
            EventPayload::ThreadCreated { .. }
            | EventPayload::ThreadUpdated { .. }
            | EventPayload::ThreadArchived
            | EventPayload::ProviderSessionBound { .. }
            | EventPayload::ProviderNotice { .. }
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
