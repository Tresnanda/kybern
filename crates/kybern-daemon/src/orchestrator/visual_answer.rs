//! `kybern_html_publish` with `await_answer`: the published visual waits for the
//! reader. The question is a daemon-owned [`VISUAL_ANSWER_TOOL`] card that
//! clients draw as an answer bar under the visual. The reader sends a value
//! the page drafted, types a reply in the composer instead, or skips.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Result, anyhow};
use kybern_protocol::*;
use serde_json::{Value, json};
use uuid::Uuid;

use super::{DaemonAnswer, LiveSession, Orchestrator};

const TURN_ENDED: &str = "turn ended";
const TIMED_OUT: &str = "timed out";

fn card_key(visual_id: Uuid) -> String {
    format!("visual:{visual_id}")
}

impl Orchestrator {
    /// Refuse a second waiting visual in the same turn before the first is published.
    pub(super) async fn ensure_one_visual_question(&self, turn_id: TurnId, live: &LiveSession) -> Result<()> {
        let waiting = live
            .daemon_approvals
            .lock()
            .await
            .values()
            .any(|entry| entry.turn_id == turn_id && entry.key.starts_with("visual:") && entry.decision.borrow().is_none());
        anyhow::ensure!(!waiting, "A visual in this turn is already waiting for an answer. Wait for it before asking another.");
        Ok(())
    }

    pub(super) async fn execute_visual_answer(
        &self,
        thread_id: ThreadId,
        turn_id: TurnId,
        live: &Arc<LiveSession>,
        visual: HtmlVisual,
        wait: Duration,
    ) -> Result<Value> {
        let (this, live) = (self.clone(), live.clone());
        // Like the secret card: an answer the reader gives after the harness gave up still lands in the transcript.
        tokio::spawn(async move { this.run_visual_answer(thread_id, turn_id, live, visual, wait).await })
            .await
            .map_err(|_| anyhow!("The visual stopped waiting. Ask in your reply instead."))?
    }

    async fn run_visual_answer(
        &self,
        thread_id: ThreadId,
        turn_id: TurnId,
        live: Arc<LiveSession>,
        visual: HtmlVisual,
        wait: Duration,
    ) -> Result<Value> {
        let input = serde_json::to_value(VisualAnswerInput {
            visual_id: visual.id,
            title: visual.title.clone(),
            schema: visual.ask.as_ref().and_then(|ask| ask.schema.clone()),
        })?;
        let summary = format!("Choose in “{}”", visual.title);
        let (card, answer) = self
            .ask_daemon_approval_within(thread_id, turn_id, &live, card_key(visual.id), VISUAL_ANSWER_TOOL, input, summary, None, wait)
            .await?;
        let decision = match answer {
            DaemonAnswer::Decided(decision) => Some(decision),
            DaemonAnswer::TurnEnded => None,
            DaemonAnswer::Pending => match self.close_unanswered_secret_card(thread_id, turn_id, &live, card).await? {
                Some(decision) => Some(decision),
                None => Some(ApprovalDecision::Deny { reason: Some(TIMED_OUT.into()) }),
            },
        };
        let (status, answer, label, reply) = match decision {
            Some(ApprovalDecision::Submit { response }) => match response.get("reply").and_then(Value::as_str) {
                Some(reply) => (VisualAnswerStatus::Replied, None, None, Some(reply.trim().to_owned())),
                None => (
                    VisualAnswerStatus::Answered,
                    response.get("answer").cloned(),
                    response.get("label").and_then(Value::as_str).map(str::to_owned),
                    None,
                ),
            },
            Some(ApprovalDecision::Deny { reason }) if reason.as_deref() == Some(TIMED_OUT) => {
                (VisualAnswerStatus::TimedOut, None, None, None)
            }
            Some(ApprovalDecision::Deny { reason }) if reason.as_deref() == Some(TURN_ENDED) => {
                (VisualAnswerStatus::Cancelled, None, None, None)
            }
            Some(ApprovalDecision::Deny { .. }) => (VisualAnswerStatus::Skipped, None, None, None),
            Some(_) => (VisualAnswerStatus::Skipped, None, None, None),
            None => (VisualAnswerStatus::Cancelled, None, None, None),
        };
        let message = reply.as_ref().map(|reply| UserMessage::text(reply.clone()));
        let message_id = message.as_ref().map(|_| Uuid::now_v7());
        self.emit(
            thread_id,
            Some(turn_id),
            EventPayload::VisualAnswered {
                visual_id: visual.id,
                status,
                answer: answer.clone(),
                label: label.clone(),
                message_id,
                message,
            },
        )?;
        Ok(visual_result(status, answer, label, reply))
    }
}

/// What the waiting tool call returns.
pub(super) fn visual_result(status: VisualAnswerStatus, answer: Option<Value>, label: Option<String>, reply: Option<String>) -> Value {
    let (name, note) = match status {
        VisualAnswerStatus::Answered => ("answered", "The reader answered in the visual. Continue with this answer."),
        VisualAnswerStatus::Replied => {
            ("replied", "The reader typed this reply instead of choosing in the visual. Treat it as their answer.")
        }
        VisualAnswerStatus::Skipped => ("skipped", "The reader skipped the question. Continue without it or ask in words."),
        VisualAnswerStatus::Cancelled => ("cancelled", "The turn ended before an answer."),
        VisualAnswerStatus::TimedOut => {
            ("timed_out", "Nobody answered in time. Continue without it; the reader can answer later as a message.")
        }
    };
    let mut result = json!({ "status": name, "message": note });
    if let Some(answer) = answer {
        result["answer"] = answer;
    }
    if let Some(label) = label {
        result["label"] = label.into();
    }
    if let Some(reply) = reply {
        result["reply"] = reply.into();
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn results_name_each_outcome() {
        let answered = visual_result(VisualAnswerStatus::Answered, Some(json!({"layout":"B"})), Some("Layout B".into()), None);
        assert_eq!(answered["status"], "answered");
        assert_eq!(answered["answer"]["layout"], "B");
        assert_eq!(answered["label"], "Layout B");
        let replied = visual_result(VisualAnswerStatus::Replied, None, None, Some("B, but left".into()));
        assert_eq!(replied["status"], "replied");
        assert_eq!(replied["reply"], "B, but left");
        for (status, name) in [
            (VisualAnswerStatus::Skipped, "skipped"),
            (VisualAnswerStatus::Cancelled, "cancelled"),
            (VisualAnswerStatus::TimedOut, "timed_out"),
        ] {
            let value = visual_result(status, None, None, None);
            assert_eq!(value["status"], name);
            assert!(value.get("answer").is_none());
        }
    }
}
