//! Event-sourced thread log. Every state change to a thread is an event; the
//! daemon persists them in order and clients subscribe to the stream.

use chrono::{DateTime, Utc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::collaboration::*;
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
    /// Worktree metadata stays on the thread; this ref retains the recoverable source.
    WorktreeCleaned {
        branch: String,
        recovery_commit: String,
    },
    WorktreeRestored {
        branch: String,
    },
    /// A saved native conversation was adopted without replaying its tools.
    SessionImported {
        provider: ProviderKind,
        session_id: String,
    },
    MessageQueued {
        message: crate::methods::QueuedMessage,
    },
    MessageRemoved {
        message_id: MessageId,
    },
    MessageQueueUpdated {
        message: crate::methods::QueuedMessage,
    },
    MessageSteered {
        message_id: MessageId,
        message: UserMessage,
    },
    ThreadNotesUpdated {
        notes: crate::methods::ThreadNotes,
    },
    ProjectCoordinatorDeleted {
        project_id: crate::ProjectId,
        coordinator_thread_id: ThreadId,
    },
    CollaborationGroupUpdated {
        group: CollaborationGroup,
    },
    CollaborationMemberUpdated {
        member: GroupMember,
    },
    CollaborationAssignmentUpdated {
        assignment: CollaborationAssignment,
    },
    CollaborationMessageUpdated {
        message: CollaborationMessage,
    },
    CollaborationContextUpdated {
        entry: ContextEntry,
    },
    /// A message another thread sent this one is waiting for the user to
    /// deliver or dismiss. Emitted on the recipient thread.
    ThreadMessageHeld {
        message: ThreadMessageRecord,
    },
    /// A held message was delivered or dismissed. Emitted on the recipient thread.
    ThreadMessageResolved {
        message_id: MessageId,
        resolution: HeldResolution,
    },
    /// A thread message changed state after it was created (queued, steered,
    /// delivered, answered, dismissed or failed). Emitted on the sender's
    /// thread (when it has one) and on the recipient's.
    ThreadMessageUpdated {
        message: ThreadMessageRecord,
    },
    TurnStarted {
        message_id: MessageId,
        message: UserMessage,
    },
    /// Native provider output resumed a settled turn without a new user message.
    /// Its next completion replaces the summary with cumulative accounting.
    TurnResumed,
    /// Provider assigned or confirmed its own session id.
    ProviderSessionBound {
        session_id: String,
        model: Option<String>,
    },
    /// The daemon closed the agent process while the thread was idle. The
    /// next message resumes the provider session; nothing is lost.
    ProviderSessionReleased {
        reason: SessionReleaseReason,
    },
    AssistantTextDelta {
        message_id: MessageId,
        #[serde(default)]
        origin: EventOrigin,
        delta: String,
    },
    ImageReceived {
        id: String,
        origin: EventOrigin,
        source: String,
    },
    AssistantThinkingDelta {
        message_id: MessageId,
        #[serde(default)]
        origin: EventOrigin,
        delta: String,
    },
    /// The provider closed the reasoning it was streaming into this message.
    /// The message itself may continue with text or tool calls.
    AssistantThinkingCompleted {
        message_id: MessageId,
        #[serde(default)]
        origin: EventOrigin,
    },
    AssistantMessageCompleted {
        message_id: MessageId,
        #[serde(default)]
        origin: EventOrigin,
        text: String,
        thinking: Option<String>,
    },
    HtmlPublished {
        visual: HtmlVisual,
    },
    ToolCallStarted {
        call: ToolCall,
        #[serde(default)]
        origin: EventOrigin,
    },
    ToolCallOutputDelta {
        tool_call_id: String,
        delta: String,
    },
    ToolCallCompleted {
        tool_call_id: String,
        output: Value,
        /// Transport-only marker used by opt-in compact event subscriptions.
        /// Persisted events always leave this false; clients fetch the exact
        /// result through `threads.tool_output` when it is true.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        output_omitted: bool,
        /// Transport-only capability marker for exact output-delta recovery.
        /// Durable events leave this false; compact subscriptions set it when
        /// the matching sequence-bounded RPC is available.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        stream_recoverable: bool,
        is_error: bool,
    },
    /// A provider-owned subagent, process, or monitor became visible.
    RuntimeTaskStarted {
        task: RuntimeTask,
    },
    /// Full latest-state snapshot for an existing provider-owned task.
    RuntimeTaskUpdated {
        task: RuntimeTask,
    },
    /// Terminal snapshot retained in the event log for history and recovery.
    RuntimeTaskCompleted {
        task: RuntimeTask,
    },
    AsyncQuestionsRequested {
        request: AsyncQuestionRequest,
    },
    AsyncQuestionsAnswered {
        request_id: String,
        answers: Vec<String>,
        message_id: MessageId,
        message: UserMessage,
    },
    UserInputRequested {
        approval: ApprovalRequest,
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
        /// Durable identity of the terminal non-empty root assistant message.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        terminal_message_id: Option<MessageId>,
    },
    TurnFailed {
        error: String,
    },
    ProviderCommandsUpdated {
        commands: Vec<crate::ProviderCommand>,
    },
    /// A same-thread native account/harness transition. Context telemetry and
    /// commands from the outgoing session no longer describe the new session.
    SessionTransitioned {
        from: ProviderInstance,
        to: ProviderInstance,
        native_resume: bool,
        text: String,
    },
    ProviderUsageUpdated {
        usage: ProviderUsage,
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

impl EventPayload {
    /// The persisted/wire discriminant, without allocating or traversing payload data.
    /// Keep this exhaustive: adding an event must also select its Serde wire tag.
    pub const fn kind(&self) -> &'static str {
        match self {
            Self::ThreadCreated { .. } => "thread_created",
            Self::ThreadUpdated { .. } => "thread_updated",
            Self::ThreadArchived => "thread_archived",
            Self::WorktreeCleaned { .. } => "worktree_cleaned",
            Self::WorktreeRestored { .. } => "worktree_restored",
            Self::SessionImported { .. } => "session_imported",
            Self::MessageQueued { .. } => "message_queued",
            Self::MessageRemoved { .. } => "message_removed",
            Self::MessageQueueUpdated { .. } => "message_queue_updated",
            Self::MessageSteered { .. } => "message_steered",
            Self::ThreadNotesUpdated { .. } => "thread_notes_updated",
            Self::ProjectCoordinatorDeleted { .. } => "project_coordinator_deleted",
            Self::CollaborationGroupUpdated { .. } => "collaboration_group_updated",
            Self::CollaborationMemberUpdated { .. } => "collaboration_member_updated",
            Self::CollaborationAssignmentUpdated { .. } => "collaboration_assignment_updated",
            Self::CollaborationMessageUpdated { .. } => "collaboration_message_updated",
            Self::CollaborationContextUpdated { .. } => "collaboration_context_updated",
            Self::ThreadMessageHeld { .. } => "thread_message_held",
            Self::ThreadMessageResolved { .. } => "thread_message_resolved",
            Self::ThreadMessageUpdated { .. } => "thread_message_updated",
            Self::TurnStarted { .. } => "turn_started",
            Self::TurnResumed => "turn_resumed",
            Self::ProviderSessionBound { .. } => "provider_session_bound",
            Self::ProviderSessionReleased { .. } => "provider_session_released",
            Self::AssistantTextDelta { .. } => "assistant_text_delta",
            Self::ImageReceived { .. } => "image_received",
            Self::AssistantThinkingDelta { .. } => "assistant_thinking_delta",
            Self::AssistantThinkingCompleted { .. } => "assistant_thinking_completed",
            Self::AssistantMessageCompleted { .. } => "assistant_message_completed",
            Self::HtmlPublished { .. } => "html_published",
            Self::ToolCallStarted { .. } => "tool_call_started",
            Self::ToolCallOutputDelta { .. } => "tool_call_output_delta",
            Self::ToolCallCompleted { .. } => "tool_call_completed",
            Self::RuntimeTaskStarted { .. } => "runtime_task_started",
            Self::RuntimeTaskUpdated { .. } => "runtime_task_updated",
            Self::RuntimeTaskCompleted { .. } => "runtime_task_completed",
            Self::AsyncQuestionsRequested { .. } => "async_questions_requested",
            Self::AsyncQuestionsAnswered { .. } => "async_questions_answered",
            Self::UserInputRequested { .. } => "user_input_requested",
            Self::ApprovalRequested { .. } => "approval_requested",
            Self::ApprovalResolved { .. } => "approval_resolved",
            Self::TurnCompleted { .. } => "turn_completed",
            Self::TurnFailed { .. } => "turn_failed",
            Self::ProviderCommandsUpdated { .. } => "provider_commands_updated",
            Self::SessionTransitioned { .. } => "session_transitioned",
            Self::ProviderUsageUpdated { .. } => "provider_usage_updated",
            Self::ProviderNotice { .. } => "provider_notice",
            Self::CheckpointUpdated { .. } => "checkpoint_updated",
            Self::WorkspaceReverted { .. } => "workspace_reverted",
        }
    }
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

/// Sent after all subscription replay events through `head_seq` have been queued.
/// Live events for the connection cannot overtake this notification.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct EventsReadyNotification {
    pub subscription_id: SubscriptionId,
    pub head_seq: EventSeq,
}

#[cfg(test)]
mod kind_tests {
    use super::*;

    #[test]
    fn kind_matches_serde_for_empty_scalar_and_large_payload_events() {
        let examples = [
            EventPayload::ThreadArchived,
            EventPayload::TurnResumed,
            EventPayload::MessageRemoved { message_id: MessageId::nil() },
            EventPayload::ToolCallOutputDelta { tool_call_id: "a:b".into(), delta: "😀\n\0".into() },
            EventPayload::ToolCallCompleted {
                tool_call_id: "a:b".into(),
                output: serde_json::json!({ "nested": [null, true, "x".repeat(1024 * 1024)] }),
                output_omitted: false,
                stream_recoverable: false,
                is_error: false,
            },
            EventPayload::AssistantTextDelta { message_id: MessageId::nil(), origin: Default::default(), delta: "é".into() },
            EventPayload::AssistantThinkingDelta { message_id: MessageId::nil(), origin: Default::default(), delta: String::new() },
            EventPayload::AssistantThinkingCompleted { message_id: MessageId::nil(), origin: Default::default() },
            EventPayload::AssistantMessageCompleted {
                message_id: MessageId::nil(),
                origin: Default::default(),
                text: "done".into(),
                thinking: None,
            },
            EventPayload::ProviderNotice { level: NoticeLevel::Info, text: "notice".into(), data: None },
            EventPayload::ProviderUsageUpdated { usage: Default::default() },
            EventPayload::ProviderCommandsUpdated { commands: Vec::new() },
            EventPayload::WorkspaceReverted { to_turn_id: TurnId::nil(), commit: "abc".into() },
            EventPayload::ThreadMessageResolved { message_id: MessageId::nil(), resolution: HeldResolution::Dismissed },
            EventPayload::ThreadMessageHeld {
                message: ThreadMessageRecord {
                    id: MessageId::nil(),
                    operation_id: uuid::Uuid::nil(),
                    from_thread_id: None,
                    to_thread_id: ThreadId::nil(),
                    purpose: ThreadMessagePurpose::Question,
                    reply_to: None,
                    body: "hi".into(),
                    delivery: ThreadMessageDelivery::Queue,
                    state: ThreadMessageState::Held,
                    held_reason: Some("permission".into()),
                    created_at: chrono::Utc::now(),
                    updated_at: chrono::Utc::now(),
                },
            },
            EventPayload::ThreadMessageUpdated {
                message: ThreadMessageRecord {
                    id: MessageId::nil(),
                    operation_id: uuid::Uuid::nil(),
                    from_thread_id: Some(ThreadId::nil()),
                    to_thread_id: ThreadId::nil(),
                    purpose: ThreadMessagePurpose::Message,
                    reply_to: None,
                    body: "hi".into(),
                    delivery: ThreadMessageDelivery::Queue,
                    state: ThreadMessageState::Delivered,
                    held_reason: None,
                    created_at: chrono::Utc::now(),
                    updated_at: chrono::Utc::now(),
                },
            },
        ];
        for event in examples {
            let wire = serde_json::to_value(&event).unwrap();
            let tag: &'static str = event.kind();
            assert_eq!(wire["kind"].as_str(), Some(tag));
            let restored: EventPayload = serde_json::from_value(wire).unwrap();
            assert_eq!(restored.kind(), tag);
        }
    }

    #[test]
    fn legacy_tool_completion_defaults_to_full_output() {
        let payload: EventPayload = serde_json::from_value(serde_json::json!({
            "kind": "tool_call_completed",
            "tool_call_id": "legacy",
            "output": "ok",
            "is_error": false,
        }))
        .unwrap();
        assert!(matches!(payload, EventPayload::ToolCallCompleted { output_omitted: false, stream_recoverable: false, .. }));
    }
}
