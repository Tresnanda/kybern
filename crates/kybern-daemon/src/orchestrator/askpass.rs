//! The card behind `kybern askpass`: a password, passphrase, git login or SSH
//! host-key prompt that a command in an agent session hit.
//!
//! Always a private card (`PROMPT_REQUEST_TOOL`). It is never answered
//! automatically in any permission mode, the answer is never stored or logged
//! (the store redacts a `secret`, the card's in-memory copy is scrubbed once
//! read), and a refusal or a cancel makes the asking command fail.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use kybern_protocol::*;
use serde_json::json;
use uuid::Uuid;

use super::Orchestrator;
use crate::askpass::{self, WAIT_SECONDS};

/// What `kybern askpass` prints, or why it fails.
pub(crate) enum PromptReply {
    Answer(String),
    Cancelled(String),
}

const MAX_PENDING_PER_THREAD: usize = 3;
/// A command that asks the same prompt again within this long is on its next try.
const RETRY_WINDOW: Duration = Duration::from_secs(120);

type Attempts = HashMap<(ThreadId, u32, String), (u32, Instant)>;

fn attempts() -> &'static Mutex<Attempts> {
    static ATTEMPTS: OnceLock<Mutex<Attempts>> = OnceLock::new();
    ATTEMPTS.get_or_init(Default::default)
}

fn pending() -> &'static Mutex<HashMap<ThreadId, usize>> {
    static PENDING: OnceLock<Mutex<HashMap<ThreadId, usize>>> = OnceLock::new();
    PENDING.get_or_init(Default::default)
}

/// How many times this command (by the helper's parent process) has asked this prompt lately.
fn count_attempt(thread_id: ThreadId, parent: u32, prompt: &str) -> u32 {
    let mut map = attempts().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    map.retain(|_, (_, at)| at.elapsed() < RETRY_WINDOW);
    let entry = map.entry((thread_id, parent, prompt.to_string())).or_insert((0, Instant::now()));
    entry.0 += 1;
    entry.1 = Instant::now();
    entry.0
}

struct PendingSlot(ThreadId);

impl PendingSlot {
    fn take(thread_id: ThreadId) -> Option<Self> {
        let mut map = pending().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let count = map.entry(thread_id).or_default();
        if *count >= MAX_PENDING_PER_THREAD {
            return None;
        }
        *count += 1;
        Some(Self(thread_id))
    }
}

impl Drop for PendingSlot {
    fn drop(&mut self) {
        let mut map = pending().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(count) = map.get_mut(&self.0) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                map.remove(&self.0);
            }
        }
    }
}

fn cancelled(message: &str) -> PromptReply {
    PromptReply::Cancelled(message.into())
}

impl Orchestrator {
    /// A prompt from `pid`, a helper process of this session. Waits for the user.
    pub(crate) async fn ask_prompt(&self, thread_id: ThreadId, session_instance_id: Uuid, prompt: String, pid: u32) -> PromptReply {
        let live = self.inner.sessions.lock().await.get(&thread_id).cloned();
        let Some(live) = live.filter(|live| live.session_instance_id == session_instance_id) else {
            return cancelled("This agent session has ended, so nobody can answer. Run the command again from a live session.");
        };
        let Some(turn_id) = self.owns_app_tool_turn(thread_id, &live, None).await else {
            return cancelled("The agent isn't running a turn, so there is nobody to ask. Run the command again from the agent.");
        };
        let Ok(Some(thread)) = self.inner.store.thread_get(thread_id) else {
            return cancelled("This chat no longer exists.");
        };
        // Only a real sudo, ssh or git may ask: the agent's own shell running `kybern askpass` could fake a sudo prompt.
        // Tests stand in for sudo with their own process.
        let trusted = (cfg!(test) && pid == std::process::id())
            || tokio::task::spawn_blocking(move || askpass::asked_by_trusted_program(pid)).await.unwrap_or(false);
        if !trusted {
            return cancelled(
                "Kybern only shows a password prompt that sudo, ssh or git asked for. Run the real command (for example `sudo -A …`) instead.",
            );
        }
        let command = tokio::task::spawn_blocking(move || askpass::requesting_command(pid)).await.ok().flatten();
        let class = askpass::classify(&prompt, command.as_deref());
        if let Some(host) = class.host.as_deref().filter(|host| class.purpose.starts_with("git_") && askpass::is_github(host)) {
            return PromptReply::Cancelled(format!(
                "{host} needs a sign-in, not a password. Ask the agent to call kybern_request_login with cli \"gh\", then run the command again."
            ));
        }
        let Some(_slot) = PendingSlot::take(thread_id) else {
            return cancelled("Too many prompts are waiting for an answer. Answer or cancel them in Kybern, then run the command again.");
        };
        let parent = tokio::task::spawn_blocking(move || {
            std::process::Command::new("ps")
                .args(["-o", "ppid=", "-p", &pid.to_string()])
                .output()
                .ok()
                .and_then(|output| String::from_utf8_lossy(&output.stdout).trim().parse::<u32>().ok())
                .unwrap_or(0)
        })
        .await
        .unwrap_or(0);
        let attempt = count_attempt(thread_id, parent, &askpass::clean_prompt(&prompt));
        let input = askpass::card_input(&class, &prompt, command, thread.provider.kind.display_name(), attempt);
        let summary = format!("Password prompt from {}", input.command.as_deref().unwrap_or("a command"));
        let key = format!("askpass:{}", Uuid::now_v7());
        let Ok(input) = serde_json::to_value(&input) else { return cancelled("Kybern could not show the prompt.") };
        let (card, mut decision) =
            match self.open_daemon_card(thread_id, turn_id, &live, key, PROMPT_REQUEST_TOOL, input, summary, None).await {
                Ok(opened) => opened,
                Err(_) => return cancelled("Kybern could not show the prompt. Run the command again."),
            };
        // The asking command may give up first (Claude's Bash stops a command after 2 min): then the card goes too.
        let gone = async {
            while tokio::task::spawn_blocking(move || askpass::process_alive(pid)).await.unwrap_or(false) {
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        };
        let waited = tokio::time::timeout(Duration::from_secs(WAIT_SECONDS), async {
            tokio::select! {
                answer = super::request_tools::wait_decision(&mut decision) => Some(answer),
                () = gone => None,
            }
        })
        .await;
        let answer = match waited {
            Ok(Some(answer)) => answer,
            Ok(None) => {
                let exited = ApprovalDecision::Deny { reason: Some("command exited".into()) };
                match self.finish_daemon_card(thread_id, turn_id, &live, card, exited).await {
                    Ok(true) | Err(_) => {
                        live.daemon_approvals.lock().await.remove(&card);
                        return cancelled("The command that asked has already exited.");
                    }
                    Ok(false) => decision.borrow().clone(),
                }
            }
            Err(_) => {
                let timed_out = ApprovalDecision::Deny { reason: Some("timed out".into()) };
                // The user may have answered in the same instant: that answer stands.
                match self.finish_daemon_card(thread_id, turn_id, &live, card, timed_out).await {
                    Ok(true) | Err(_) => return cancelled("Nobody answered the prompt in 5 min, so the command failed."),
                    Ok(false) => decision.borrow().clone(),
                }
            }
        };
        let reply = match answer {
            Some(ApprovalDecision::Submit { response }) => {
                let text = |key: &str| response.get(key).and_then(|value| value.as_str()).map(str::to_owned);
                let reply = if class.confirm {
                    response
                        .get("confirmed")
                        .and_then(|value| value.as_bool())
                        .map(|yes| PromptReply::Answer(if yes { "yes" } else { "no" }.into()))
                } else if class.secret {
                    text("secret").map(PromptReply::Answer)
                } else {
                    text("value").map(PromptReply::Answer)
                };
                drop(response);
                // The card keeps its answer until the turn ends: replace the secret in it.
                if class.secret
                    && let Some(entry) = live.daemon_approvals.lock().await.get(&card)
                {
                    entry.decision.send_replace(Some(ApprovalDecision::Submit { response: json!({ "secret": REDACTED_SECRET }) }));
                }
                reply.unwrap_or_else(|| cancelled("The answer was empty, so the command failed."))
            }
            Some(ApprovalDecision::Deny { reason }) if reason.as_deref() == Some("turn ended") => {
                cancelled("The turn ended, so the command failed.")
            }
            Some(ApprovalDecision::Deny { .. }) => cancelled("You cancelled the prompt, so the command failed."),
            _ => cancelled("The prompt was not answered, so the command failed."),
        };
        // An answered card leaves the turn's list so its entry does not pile up.
        live.daemon_approvals.lock().await.remove(&card);
        reply
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_repeated_prompt_counts_as_the_next_attempt() {
        let thread = Uuid::now_v7();
        assert_eq!(count_attempt(thread, 41, "[sudo] password for me:"), 1);
        assert_eq!(count_attempt(thread, 41, "[sudo] password for me:"), 2);
        assert_eq!(count_attempt(thread, 42, "[sudo] password for me:"), 1, "another command starts over");
    }

    #[test]
    fn a_thread_holds_a_few_prompts_at_once() {
        let thread = Uuid::now_v7();
        let slots: Vec<_> = (0..MAX_PENDING_PER_THREAD).map(|_| PendingSlot::take(thread).unwrap()).collect();
        assert!(PendingSlot::take(thread).is_none());
        drop(slots);
        assert!(PendingSlot::take(thread).is_some());
    }
}
