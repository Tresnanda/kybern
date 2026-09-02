//! Event-sourced thread log. Every state change to a thread is an event; the
//! daemon persists them in order and clients subscribe to the stream.

use chrono::{DateTime, Utc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::model::*;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ThreadEvent {
    pub seq: EventSeq,
    pub thread_id: ThreadId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<TurnId>,
    pub at: DateTime<Utc>,
    #[serde(flatten)]
    pub payload: EventPayload,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EventPayload {
    ThreadCreated {
        thread: Thread,
    },
    /// Title, model, permission mode, pin, status or session changed.
    ThreadUpdated {
        thread: Thread,
    },
    ThreadArchived,
    TurnStarted {
        message_id: MessageId,
        message: UserMessage,
    },
    /// Provider assigned or confirmed its own session id.
    ProviderSessionBound {
        session_id: String,
        model: Option<String>,
    },
    AssistantTextDelta {
        message_id: MessageId,
        delta: String,
    },
    AssistantThinkingDelta {
        message_id: MessageId,
        delta: String,
    },
    AssistantMessageCompleted {
        message_id: MessageId,
        text: String,
        thinking: Option<String>,
    },
    ToolCallStarted {
        call: ToolCall,
    },
    ToolCallOutputDelta {
        tool_call_id: String,
        delta: String,
    },
    ToolCallCompleted {
        tool_call_id: String,
        output: Value,
        is_error: bool,
    },
    ApprovalRequested {
        approval: ApprovalRequest,
    },
    ApprovalResolved {
        approval_id: ApprovalId,
        decision: ApprovalDecision,
    },
    TurnCompleted {
        stop_reason: StopReason,
        usage: Usage,
        cost_usd: Option<f64>,
        duration_ms: u64,
    },
    TurnFailed {
        error: String,
    },
    /// Provider emitted an informational notice (compaction, status, warnings).
    ProviderNotice {
        level: NoticeLevel,
        text: String,
        data: Option<Value>,
    },
    /// A git checkpoint was taken or completed for this turn.
    CheckpointUpdated {
        checkpoint: Checkpoint,
    },
    /// The working tree was reset to the state before `turn_id`.
    WorkspaceReverted {
        to_turn_id: TurnId,
        commit: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum NoticeLevel {
    Info,
    Warning,
    Error,
}

/// Params of the `event` notification.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct EventNotification {
    pub subscription_id: SubscriptionId,
    pub event: ThreadEvent,
}
