//! Types for reading and searching other threads through `threads.read` / `threads.search`.

use chrono::{DateTime, Utc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{ThreadId, TurnId};

pub type OperationId = Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ThreadMessageRole {
    User,
    Assistant,
    System,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ThreadMessageAttributionKind {
    User,
    Agent,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ThreadMessageAttribution {
    pub kind: ThreadMessageAttributionKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ThreadReadMessage {
    pub seq: crate::EventSeq,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<TurnId>,
    pub role: ThreadMessageRole,
    pub text: String,
    pub created_at: DateTime<Utc>,
    pub attribution: ThreadMessageAttribution,
    /// Byte offset of this UTF-8-safe text chunk within the settled message.
    #[serde(default)]
    pub text_offset: u64,
    /// Continue this one message at the given offset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_text_offset: Option<u64>,
    #[serde(default)]
    pub text_truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ThreadSearchHit {
    pub thread: crate::Thread,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub matched_at: Option<DateTime<Utc>>,
}
