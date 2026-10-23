//! The `kybern_request_pick` tool: ask the user to point at something through a
//! daemon-owned approval card and return what they picked.
//!
//! The card's answer is not secret, so it is stored like any other answer; the
//! tool result is built from it by `pick::picked_result`, which bounds every field.

use std::sync::Arc;

use anyhow::{Result, anyhow};
use kybern_protocol::*;
use serde_json::Value;
use uuid::Uuid;

use super::{DaemonAnswer, LiveSession, Orchestrator};
use crate::pick::{self, PickRequest};

const TURN_ENDED: &str = "turn ended";
const TIMED_OUT: &str = "timed out";

impl Orchestrator {
    pub(super) async fn execute_request_pick(
        &self,
        thread: &Thread,
        turn_id: TurnId,
        live: &Arc<LiveSession>,
        arguments: Value,
    ) -> Result<Value> {
        let request = PickRequest::parse(arguments)?;
        let kind = request.input.kind;
        let input = serde_json::to_value(&request.input)?;
        let summary = format!("Point to something: {}", request.input.prompt);
        // Each call is its own card: a pick is never reused from an earlier answer.
        let key = format!("pick:{}", Uuid::now_v7());
        let (card, answer) = self
            .ask_daemon_approval_within(thread.id, turn_id, live, key, PICK_REQUEST_TOOL, input, summary, None, request.timeout)
            .await?;
        let decision = match answer {
            DaemonAnswer::Decided(decision) => decision,
            DaemonAnswer::TurnEnded => return Ok(pick::outcome("cancelled", kind)),
            DaemonAnswer::Pending => match self.close_unanswered_secret_card(thread.id, turn_id, live, card).await? {
                Some(decision) => decision,
                None => return Ok(pick::outcome("timed_out", kind)),
            },
        };
        match decision {
            ApprovalDecision::Submit { response } => {
                let (store, assets) = (self.inner.store.clone(), self.inner.paths.assets.clone());
                pick::picked_result(kind, &response, |id| {
                    let id: AssetId = id.parse().ok()?;
                    store.asset_get(id).ok().flatten()?;
                    Some(assets.join(id.to_string()))
                })
            }
            ApprovalDecision::Deny { reason } if reason.as_deref() == Some(TURN_ENDED) => Ok(pick::outcome("cancelled", kind)),
            ApprovalDecision::Deny { reason } if reason.as_deref() == Some(TIMED_OUT) => Ok(pick::outcome("timed_out", kind)),
            ApprovalDecision::Deny { .. } => Ok(pick::outcome("declined", kind)),
            _ => Err(anyhow!("The answer did not hold a pick. Call kybern_request_pick again.")),
        }
    }
}
