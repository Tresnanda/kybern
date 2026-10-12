//! The `kybern_request_secret` tool: ask the user for one secret through a
//! daemon-owned approval card and write it to an env file in the workspace.
//!
//! The secret exists only in the answer's live delivery to this tool and in the
//! file. The store redacts it from the stored and broadcast copies of the
//! answer, the card's in-memory answer is scrubbed once read, the result never
//! holds it, and nothing here traces it.

use std::path::Path;
use std::sync::Arc;

use anyhow::{Result, anyhow};
use kybern_protocol::*;
use serde_json::{Value, json};
use uuid::Uuid;

use super::{DaemonAnswer, LiveSession, Orchestrator};
use crate::secrets::{self, SecretRequest, SecretTarget};

/// Why a card was denied because its turn ended (see `resolve_finished_requests`).
const TURN_ENDED: &str = "turn ended";
/// Why a card was denied because nobody answered in time.
const TIMED_OUT: &str = "timed out";

fn outcome(status: &str, request: &SecretRequest, target: &SecretTarget, replaced: bool) -> Value {
    json!({ "status": status, "env_key": request.env_key, "file": target.display, "replaced": replaced })
}

impl Orchestrator {
    pub(super) async fn execute_request_secret(
        &self,
        thread: &Thread,
        turn_id: TurnId,
        live: &Arc<LiveSession>,
        arguments: Value,
    ) -> Result<Value> {
        let request = SecretRequest::parse(arguments)?;
        let target = secrets::resolve_target(Path::new(&thread.cwd), &request.file, &request.env_key).await?;
        let (this, live, thread_id) = (self.clone(), live.clone(), thread.id);
        // The wait and the write run in their own task: if the harness gives up on
        // the call first, an answer the user already gave is still saved.
        tokio::spawn(async move { this.run_secret_request(thread_id, turn_id, live, request, target).await })
            .await
            .map_err(|_| anyhow!("The secret request failed. Call kybern_request_secret again."))?
    }

    pub(super) async fn run_secret_request(
        &self,
        thread_id: ThreadId,
        turn_id: TurnId,
        live: Arc<LiveSession>,
        request: SecretRequest,
        target: SecretTarget,
    ) -> Result<Value> {
        let input = serde_json::to_value(SecretRequestInput {
            label: request.label.clone(),
            reason: request.reason.clone(),
            env_key: request.env_key.clone(),
            file: target.display.clone(),
            replaces: target.replaces,
            placeholder: request.placeholder.clone(),
        })?;
        let summary = format!("Provide {} (saved to {})", request.label, target.display);
        // Each call is its own card: a secret is never reused from an earlier answer.
        let key = format!("secret:{}", Uuid::now_v7());
        let (card, answer) = self
            .ask_daemon_approval_within(thread_id, turn_id, &live, key, SECRET_REQUEST_TOOL, input, summary, None, request.timeout)
            .await?;
        let decision = match answer {
            DaemonAnswer::Decided(decision) => decision,
            DaemonAnswer::TurnEnded => return Ok(outcome("cancelled", &request, &target, false)),
            DaemonAnswer::Pending => match self.close_unanswered_secret_card(thread_id, turn_id, &live, card).await? {
                Some(decision) => decision,
                None => return Ok(outcome("timed_out", &request, &target, false)),
            },
        };
        match decision {
            ApprovalDecision::Submit { response } => {
                let secret = response.get("secret").and_then(Value::as_str).map(str::to_owned);
                drop(response);
                self.scrub_secret_answer(&live, card).await;
                let secret = secret.ok_or_else(|| anyhow!("The answer held no value. Call kybern_request_secret again."))?;
                let (path, key) = (target.path.clone(), request.env_key.clone());
                let written = tokio::task::spawn_blocking(move || secrets::write_env_value(&path, &key, &secret))
                    .await
                    .map_err(|_| anyhow!("Kybern could not save the secret. Nothing was written; call kybern_request_secret again."))?;
                match written {
                    Ok(replaced) => Ok(outcome("saved", &request, &target, replaced)),
                    Err(error) => Err(anyhow!(
                        "Kybern could not save the secret to {}: {error:#}. The value was discarded; fix the problem, then call kybern_request_secret again.",
                        target.display
                    )),
                }
            }
            ApprovalDecision::Deny { reason } if reason.as_deref() == Some(TURN_ENDED) => {
                Ok(outcome("cancelled", &request, &target, false))
            }
            ApprovalDecision::Deny { reason } if reason.as_deref() == Some(TIMED_OUT) => Ok(outcome("timed_out", &request, &target, false)),
            ApprovalDecision::Deny { .. } => Ok(outcome("declined", &request, &target, false)),
            _ => Err(anyhow!("The answer did not hold a value. Call kybern_request_secret again.")),
        }
    }

    /// The wait ran out. Close the card as timed out, unless the user answered
    /// in the same instant: then that answer is returned to be saved.
    pub(super) async fn close_unanswered_secret_card(
        &self,
        thread_id: ThreadId,
        turn_id: TurnId,
        live: &LiveSession,
        card: ApprovalId,
    ) -> Result<Option<ApprovalDecision>> {
        let Some(entry) = live.daemon_approvals.lock().await.remove(&card) else { return Ok(None) };
        if let Some(answer) = entry.decision.borrow().clone() {
            return Ok(Some(answer));
        }
        let decision = ApprovalDecision::Deny { reason: Some(TIMED_OUT.into()) };
        entry.decision.send_replace(Some(decision.clone()));
        self.inner.store.approval_resolve(card, &decision)?;
        self.emit(thread_id, Some(turn_id), EventPayload::ApprovalResolved { approval_id: card, decision })?;
        self.restore_running_after_approval(thread_id, live).await?;
        Ok(None)
    }

    /// Replace the secret the card still holds in memory with its redacted form.
    async fn scrub_secret_answer(&self, live: &LiveSession, card: ApprovalId) {
        if let Some(entry) = live.daemon_approvals.lock().await.get(&card) {
            entry.decision.send_replace(Some(ApprovalDecision::Submit { response: json!({ "secret": REDACTED_SECRET }) }));
        }
    }
}
