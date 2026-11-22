//! A prompt's life: how it settles (its answer, the agent's own completion notice, or a Stop the agent
//! ignores), steering by a follow-up prompt, and the wait for a resumed session's replay.

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use agent_client_protocol::schema::v1::{ContentBlock, StopReason as AcpStop};
use kybern_protocol::{PermissionMode, StopReason, Usage};
use tokio::sync::{mpsc, oneshot};

use crate::{DriverError, DriverEvent, Result, SessionConfig};

/// How long a resumed session's replay may stay quiet before the load counts as done. Grok can leave
/// `session/load` unanswered after it has replayed the conversation (T3 Code, 52b04b947e).
const LOAD_REPLAY_IDLE: Duration = Duration::from_secs(2);
/// The longest Kybern waits for `session/load` (or a quiet replay) before giving up.
pub(crate) const LOAD_TIMEOUT: Duration = Duration::from_secs(90);

/// How long the agent has to answer a Stop or Close before the turn ends as interrupted without it.
pub(crate) const CANCEL_GRACE: Duration = Duration::from_secs(5);

/// A session's waits. Tests shorten them through the session's env (`KYBERN_TEST_ACP_*_MS`), since a
/// real agent child runs on real time.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Timings {
    pub(crate) replay_idle: Duration,
    pub(crate) cancel_grace: Duration,
}

#[cfg(test)]
pub(crate) const TEST_REPLAY_IDLE_MS: &str = "KYBERN_TEST_ACP_REPLAY_IDLE_MS";
#[cfg(test)]
pub(crate) const TEST_CANCEL_GRACE_MS: &str = "KYBERN_TEST_ACP_CANCEL_GRACE_MS";

impl Timings {
    pub(crate) fn for_session(config: &SessionConfig) -> Self {
        let timings = Self { replay_idle: LOAD_REPLAY_IDLE, cancel_grace: CANCEL_GRACE };
        #[cfg(test)]
        let timings = {
            let ms = |key: &str| config.env.get(key).and_then(|ms| ms.parse().ok()).map(Duration::from_millis);
            Self {
                replay_idle: ms(TEST_REPLAY_IDLE_MS).unwrap_or(timings.replay_idle),
                cancel_grace: ms(TEST_CANCEL_GRACE_MS).unwrap_or(timings.cancel_grace),
            }
        };
        #[cfg(not(test))]
        let _ = config;
        timings
    }
}

/// What a session handle asks its worker to do.
pub(crate) enum SessionCommand {
    Prompt {
        blocks: Vec<ContentBlock>,
    },
    /// Carry the running turn on with these blocks, sent as the next prompt (agents that steer that way).
    Steer {
        blocks: Vec<ContentBlock>,
        reply: oneshot::Sender<Result<()>>,
    },
    Cancel,
    /// `session/set_mode` to `id`; Kybern's own policy follows `mode` when the flavor says so.
    SetMode {
        mode: PermissionMode,
        id: &'static str,
        reply: oneshot::Sender<Result<()>>,
    },
    /// `session/set_config_option`: the model, or a flavor's effort option.
    SetConfig {
        id: String,
        value: String,
        reply: oneshot::Sender<Result<()>>,
    },
    Close,
}

/// An agent's own "this prompt is done" notice, for a prompt whose `session/prompt` never answers.
pub(crate) trait Completion: Send + 'static {
    /// The prompt it names. Only a notice naming the running prompt settles it.
    fn prompt_id(&self) -> Option<&str>;
    /// The turn's end, `duration_ms` after it started.
    fn event(&self, duration_ms: u64) -> DriverEvent;
}

/// For a flavor whose agent sends no completion notices.
impl Completion for std::convert::Infallible {
    fn prompt_id(&self) -> Option<&str> {
        match *self {}
    }
    fn event(&self, _duration_ms: u64) -> DriverEvent {
        match *self {}
    }
}

/// A prompt's answer, already as the turn's end.
pub(crate) type PromptAnswer<'a> = Pin<Box<dyn Future<Output = DriverEvent> + Send + 'a>>;

/// What the prompt's wait can do to the agent.
pub(crate) trait PromptControl<'a> {
    /// Send `session/cancel`.
    fn cancel(&mut self);
    /// Send `blocks` as the next prompt, which carries the turn on: its id and its answer. `None` when
    /// this agent doesn't steer that way.
    fn steer(&mut self, _blocks: Vec<ContentBlock>) -> Option<(String, PromptAnswer<'a>)> {
        None
    }
}

impl<F: FnMut()> PromptControl<'_> for F {
    fn cancel(&mut self) {
        self()
    }
}

/// How a prompt's wait ended.
pub(crate) struct Settled {
    pub(crate) event: DriverEvent,
    /// Kybern closed the session (or dropped its handle) meanwhile: stop once this turn has ended.
    pub(crate) close: bool,
}

/// Wait for one prompt to end. `answer` is its `session/prompt` response, already as the turn's end.
/// The agent's own completion notice settles it only when it names this `prompt_id`: a notice without
/// one, a late one for an earlier prompt or a background task's wake would end this turn early and leave
/// its real output with no turn open. Cancel cancels; Close, or a closed command channel, cancels once
/// and is not polled again. After the first cancel the agent has `grace` to answer; then the turn ends
/// as interrupted anyway, so an agent that ignores the cancel can't hold the turn (or, after Close, its
/// process) open. A steer sends the next prompt, whose answer (or notice) then ends the turn instead.
pub(crate) async fn settle_prompt<'a, C: Completion>(
    answer: impl Future<Output = DriverEvent> + Send + 'a,
    prompt_id: &str,
    started: std::time::Instant,
    completions: &mut mpsc::UnboundedReceiver<C>,
    commands: &mut mpsc::Receiver<SessionCommand>,
    grace: Duration,
    mut control: impl PromptControl<'a>,
) -> Settled {
    let mut answer: PromptAnswer<'a> = Box::pin(answer);
    let mut prompt_id = prompt_id.to_owned();
    let mut close = false;
    let mut cancelled = false;
    let mut deadline = std::pin::pin!(tokio::time::sleep(grace));
    loop {
        tokio::select! {
            event = &mut answer => return Settled { event, close },
            Some(complete) = completions.recv() => {
                if complete.prompt_id() == Some(prompt_id.as_str()) {
                    return Settled { event: complete.event(started.elapsed().as_millis() as u64), close };
                }
            }
            () = &mut deadline, if cancelled => {
                let duration_ms = started.elapsed().as_millis() as u64;
                let event = DriverEvent::TurnCompleted {
                    stop_reason: StopReason::Interrupted,
                    usage: Usage::default(),
                    cost_usd: None,
                    duration_ms,
                    anchors: Default::default(),
                };
                return Settled { event, close };
            }
            command = commands.recv(), if !close => {
                match command {
                    Some(SessionCommand::Cancel) => control.cancel(),
                    Some(SessionCommand::Close) | None => {
                        control.cancel();
                        close = true;
                    }
                    Some(SessionCommand::Prompt { .. }) => continue,
                    Some(SessionCommand::Steer { blocks, reply }) => {
                        // A stopping turn takes no more input: the daemon sends it as a follow-up.
                        let next = if cancelled { None } else { control.steer(blocks) };
                        let sent = match next {
                            Some((id, next)) => {
                                prompt_id = id;
                                answer = next;
                                Ok(())
                            }
                            None => Err(DriverError::SteerFallback),
                        };
                        let _ = reply.send(sent);
                        continue;
                    }
                    Some(SessionCommand::SetMode { reply, .. } | SessionCommand::SetConfig { reply, .. }) => {
                        let _ = reply.send(Err(DriverError::Protocol("busy".into())));
                        continue;
                    }
                }
                if !cancelled {
                    cancelled = true;
                    deadline.as_mut().reset(tokio::time::Instant::now() + grace);
                }
            }
        }
    }
}

/// How a `session/load` wait ended.
#[derive(Debug, PartialEq)]
pub(crate) enum LoadOutcome<T> {
    /// The agent answered.
    Answered(T),
    /// The agent replayed the conversation and then went quiet without answering.
    ReplayIdle,
    TimedOut,
}

/// Wait for `load`, but count it done once a replay has started and been quiet for `idle_gap`; give up after `timeout`.
pub(crate) async fn await_session_load<T>(
    load: impl Future<Output = T>,
    last_replay: &std::sync::Mutex<Option<tokio::time::Instant>>,
    idle_gap: Duration,
    timeout: Duration,
) -> LoadOutcome<T> {
    let mut load = std::pin::pin!(load);
    let mut deadline = std::pin::pin!(tokio::time::sleep(timeout));
    let mut tick = tokio::time::interval(Duration::from_millis(50));
    loop {
        tokio::select! {
            answered = &mut load => return LoadOutcome::Answered(answered),
            _ = &mut deadline => return LoadOutcome::TimedOut,
            _ = tick.tick() => {
                let quiet = last_replay.lock().ok().and_then(|last| *last).is_some_and(|last| last.elapsed() >= idle_gap);
                if quiet {
                    return LoadOutcome::ReplayIdle;
                }
            }
        }
    }
}

pub(crate) fn stop_reason(acp: AcpStop) -> StopReason {
    match acp {
        AcpStop::EndTurn => StopReason::Completed,
        AcpStop::MaxTokens => StopReason::MaxTurns,
        AcpStop::MaxTurnRequests => StopReason::MaxTurns,
        AcpStop::Cancelled => StopReason::Interrupted,
        _ => StopReason::Completed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn_end(duration_ms: u64) -> DriverEvent {
        DriverEvent::TurnCompleted {
            stop_reason: StopReason::Completed,
            usage: Usage::default(),
            cost_usd: None,
            duration_ms,
            anchors: Default::default(),
        }
    }

    struct Steering<'s> {
        steered: &'s std::cell::Cell<u32>,
        next: Option<oneshot::Receiver<()>>,
    }

    impl<'a> PromptControl<'a> for Steering<'_> {
        fn cancel(&mut self) {}
        fn steer(&mut self, _blocks: Vec<ContentBlock>) -> Option<(String, PromptAnswer<'a>)> {
            self.steered.set(self.steered.get() + 1);
            let next = self.next.take()?;
            Some((
                "kybern-steer".into(),
                Box::pin(async move {
                    let _ = next.await;
                    turn_end(9)
                }),
            ))
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_steer_carries_the_turn_on_until_the_next_prompt_ends() {
        let (_completions_tx, mut completions) = mpsc::unbounded_channel::<std::convert::Infallible>();
        let (commands_tx, mut commands) = mpsc::channel::<SessionCommand>(4);
        let (steer_tx, steer_rx) = oneshot::channel();
        let (done_tx, done_rx) = oneshot::channel();
        commands_tx.send(SessionCommand::Steer { blocks: vec![], reply: steer_tx }).await.unwrap();
        let steered = std::cell::Cell::new(0);
        let control = Steering { steered: &steered, next: Some(done_rx) };
        let started = std::time::Instant::now();
        // The first prompt would answer at once, but the steer replaced it.
        let first = async {
            tokio::time::sleep(Duration::from_secs(1)).await;
            turn_end(1)
        };
        let wait = settle_prompt(first, "kybern-first", started, &mut completions, &mut commands, CANCEL_GRACE, control);
        let mut wait = std::pin::pin!(wait);
        assert!(tokio::time::timeout(Duration::from_secs(10), &mut wait).await.is_err(), "the first answer no longer ends the turn");
        assert!(matches!(steer_rx.await, Ok(Ok(()))));
        done_tx.send(()).unwrap();
        let settled = wait.await;
        assert!(matches!(settled.event, DriverEvent::TurnCompleted { duration_ms: 9, .. }), "{:?}", settled.event);
        assert_eq!(steered.get(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn an_agent_that_does_not_steer_or_a_stopping_turn_hands_the_input_back() {
        let (_completions_tx, mut completions) = mpsc::unbounded_channel::<std::convert::Infallible>();
        let (commands_tx, mut commands) = mpsc::channel::<SessionCommand>(4);
        let (steer_tx, steer_rx) = oneshot::channel();
        commands_tx.send(SessionCommand::Steer { blocks: vec![], reply: steer_tx }).await.unwrap();
        let started = std::time::Instant::now();
        let wait = settle_prompt(std::future::pending(), "kybern-now", started, &mut completions, &mut commands, CANCEL_GRACE, || {});
        let _ = tokio::time::timeout(Duration::from_secs(1), wait).await;
        assert!(matches!(steer_rx.await, Ok(Err(DriverError::SteerFallback))));

        // Once Stop was sent, a steer isn't sent to the agent.
        let (commands_tx, mut commands) = mpsc::channel::<SessionCommand>(4);
        let (steer_tx, steer_rx) = oneshot::channel();
        commands_tx.send(SessionCommand::Cancel).await.unwrap();
        commands_tx.send(SessionCommand::Steer { blocks: vec![], reply: steer_tx }).await.unwrap();
        let steered = std::cell::Cell::new(0);
        let control = Steering { steered: &steered, next: None };
        let settled =
            settle_prompt(std::future::pending(), "kybern-now", started, &mut completions, &mut commands, CANCEL_GRACE, control).await;
        assert!(matches!(settled.event, DriverEvent::TurnCompleted { stop_reason: StopReason::Interrupted, .. }));
        assert!(matches!(steer_rx.await, Ok(Err(DriverError::SteerFallback))));
        assert_eq!(steered.get(), 0);
    }
}
