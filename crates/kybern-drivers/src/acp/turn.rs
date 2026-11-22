//! A prompt's life: how it settles (its answer, the agent's own completion notice, or a Stop the agent
//! ignores), steering by a follow-up prompt, and the wait for a resumed session's replay.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use futures::StreamExt;

use agent_client_protocol::schema::v1::{ContentBlock, StopReason as AcpStop};
use kybern_protocol::{PermissionMode, StopReason, Usage};
use tokio::sync::{mpsc, oneshot};

use crate::{DriverError, DriverEvent, Result, SessionConfig};

/// How long a resumed session's replay may stay quiet before the load counts as done. Grok can leave
/// `session/load` unanswered after it has replayed the conversation (T3 Code, 52b04b947e).
pub(crate) const LOAD_REPLAY_IDLE: Duration = Duration::from_secs(2);
/// The longest Kybern waits for `session/load` (or a quiet replay) before giving up.
pub(crate) const LOAD_TIMEOUT: Duration = Duration::from_secs(90);

/// How long the agent has to answer a Stop or Close before the turn ends as interrupted without it.
pub(crate) const CANCEL_GRACE: Duration = Duration::from_secs(5);

/// A session's waits. Tests shorten them through the session's env (`KYBERN_TEST_ACP_*_MS`), since a
/// real agent child runs on real time.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Timings {
    /// Quiet after a replay chunk that counts as a finished load; `None` waits for the answer.
    pub(crate) replay_idle: Option<Duration>,
    /// The longest wait for `session/load`; `None` waits as long as the agent takes.
    pub(crate) load_timeout: Option<Duration>,
    pub(crate) cancel_grace: Duration,
}

#[cfg(test)]
pub(crate) const TEST_REPLAY_IDLE_MS: &str = "KYBERN_TEST_ACP_REPLAY_IDLE_MS";
#[cfg(test)]
pub(crate) const TEST_CANCEL_GRACE_MS: &str = "KYBERN_TEST_ACP_CANCEL_GRACE_MS";

impl Timings {
    pub(crate) fn for_session<F: crate::acp::AcpFlavor>(config: &SessionConfig) -> Self {
        let timings = Self { replay_idle: F::REPLAY_IDLE, load_timeout: F::LOAD_TIMEOUT, cancel_grace: CANCEL_GRACE };
        #[cfg(test)]
        let timings = {
            let ms = |key: &str| config.env.get(key).and_then(|ms| ms.parse().ok()).map(Duration::from_millis);
            Self {
                // Only a flavor that has a quiet rule can shorten it.
                replay_idle: timings.replay_idle.map(|idle| ms(TEST_REPLAY_IDLE_MS).unwrap_or(idle)),
                load_timeout: timings.load_timeout,
                cancel_grace: ms(TEST_CANCEL_GRACE_MS).unwrap_or(timings.cancel_grace),
            }
        };
        #[cfg(not(test))]
        let _ = config;
        timings
    }
}

/// How long a held turn's agent must stay quiet after its reply closed before the turn ends.
pub(crate) const HOLD_QUIET: Duration = Duration::from_secs(3);
/// How long a reply the agent opened by itself may stay quiet without closing before the turn ends anyway.
pub(crate) const OPEN_REPLY_QUIET: Duration = Duration::from_secs(120);
/// How often a held or watched turn looks at what the agent is doing.
const WATCH_TICK: Duration = Duration::from_millis(250);
/// A tick this much later than asked means the host slept: that is not the agent's silence.
const HOST_SLEEP_TOLERANCE: Duration = Duration::from_secs(10);

/// What the agent is doing, as its updates say. The update handler writes it; a prompt's wait reads it.
#[derive(Debug)]
pub(crate) struct Activity {
    /// A prompt, or a reply the agent started by itself, is open.
    pub(crate) turn_open: bool,
    /// The open turn is a reply the agent started with no prompt open.
    pub(crate) background: bool,
    /// Running tool calls, and whether each goes on after its prompt answers (a backgrounded command).
    pub(crate) tools: HashMap<String, bool>,
    /// Output arrived after the agent last closed a reply (with `usage_update`, or a prompt's answer).
    pub(crate) reply_open: bool,
    /// Cards waiting for the user.
    pub(crate) cards: usize,
    /// The agent's last update.
    pub(crate) last_progress: tokio::time::Instant,
}

impl Activity {
    pub(crate) fn new() -> Self {
        Self {
            turn_open: false,
            background: false,
            tools: HashMap::new(),
            reply_open: false,
            cards: 0,
            last_progress: tokio::time::Instant::now(),
        }
    }

    fn outliving(&self) -> bool {
        self.tools.values().any(|outlives| *outlives)
    }

    /// Waiting on a tool or on the user is not silence.
    fn busy(&self) -> bool {
        !self.tools.is_empty() || self.cards > 0
    }

    /// A held turn can end: nothing outlives it, nobody is asked, and its last reply closed (or never closes).
    fn released(&self, now: tokio::time::Instant) -> bool {
        if self.outliving() || self.cards > 0 {
            return false;
        }
        let quiet = now.saturating_duration_since(self.last_progress);
        if self.reply_open { quiet >= OPEN_REPLY_QUIET } else { quiet >= HOLD_QUIET }
    }
}

/// What, besides the prompt's answer, ends a turn: work that outlives the prompt holds it open, and an
/// agent that goes silent for too long fails it.
pub(crate) struct Watch<'a> {
    pub(crate) activity: &'a std::sync::Mutex<Activity>,
    /// Hold a completed prompt while a tool that outlives it runs, until the agent's reply to it closes.
    pub(crate) holds: bool,
    /// Fail a prompt whose agent says nothing (and runs no tool, and asks nothing) for this long.
    pub(crate) inactivity: Option<Duration>,
    /// The turn's end when the agent went silent.
    pub(crate) silent: fn() -> DriverEvent,
    /// The turn starts held: a reply the agent started by itself, ended by this event once it closes.
    pub(crate) held: Option<DriverEvent>,
}

impl Watch<'_> {
    fn lock(&self) -> std::sync::MutexGuard<'_, Activity> {
        self.activity.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// `event` with `extra` added to its usage, when it is a turn's completion.
fn with_usage(mut event: DriverEvent, extra: &Usage) -> DriverEvent {
    if let DriverEvent::TurnCompleted { usage, .. } = &mut event {
        usage.add(extra);
    }
    event
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
    /// A prompt sent while the agent was replying by itself: it ends that reply and is sent next.
    pub(crate) next: Option<Vec<ContentBlock>>,
}

/// Wait for one prompt to end. `answer` is its `session/prompt` response, already as the turn's end.
/// The agent's own completion notice settles it only when it names this `prompt_id`: a notice without
/// one, a late one for an earlier prompt or a background task's wake would end this turn early and leave
/// its real output with no turn open. Cancel cancels; Close, or a closed command channel, cancels once
/// and is not polled again. After the first cancel the agent has `grace` to answer; then the turn ends
/// as interrupted anyway, so an agent that ignores the cancel can't hold the turn (or, after Close, its
/// process) open. A steer sends the next prompt, whose answer (or notice) then ends the turn instead.
#[cfg(test)]
pub(crate) async fn settle_prompt<'a, C: Completion>(
    answer: impl Future<Output = DriverEvent> + Send + 'a,
    prompt_id: &str,
    started: std::time::Instant,
    completions: &mut mpsc::UnboundedReceiver<C>,
    commands: &mut mpsc::Receiver<SessionCommand>,
    grace: Duration,
    control: impl PromptControl<'a>,
) -> Settled {
    settle_watched(answer, prompt_id, started, completions, commands, grace, control, None).await
}

/// [`settle_prompt`], and what `watch` adds: a completed prompt stays open while work that outlives it
/// runs, a prompt whose agent goes silent fails, and a turn can start held (a reply the agent began by
/// itself). The answers of prompts a steer replaced still count their usage towards the turn.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn settle_watched<'a, C: Completion>(
    answer: impl Future<Output = DriverEvent> + Send + 'a,
    prompt_id: &str,
    started: std::time::Instant,
    completions: &mut mpsc::UnboundedReceiver<C>,
    commands: &mut mpsc::Receiver<SessionCommand>,
    grace: Duration,
    mut control: impl PromptControl<'a>,
    mut watch: Option<Watch<'_>>,
) -> Settled {
    let mut answer: PromptAnswer<'a> = Box::pin(answer);
    let mut prompt_id = prompt_id.to_owned();
    let mut close = false;
    let mut cancelled = false;
    let mut deadline = std::pin::pin!(tokio::time::sleep(grace));
    // A reply the agent started by itself: there is no prompt to answer, and a prompt ends it.
    let background = watch.as_ref().is_some_and(|watch| watch.held.is_some());
    let mut held: Option<DriverEvent> = watch.as_mut().and_then(|watch| watch.held.take());
    if held.is_some() {
        answer = Box::pin(std::future::pending());
    }
    // Answers of prompts a steer replaced: they still cost tokens.
    let mut superseded = futures::stream::FuturesUnordered::<PromptAnswer<'a>>::new();
    let mut extra = Usage::default();
    let watching = watch.as_ref().is_some_and(|watch| watch.holds || watch.inactivity.is_some());
    let mut tick = tokio::time::interval(WATCH_TICK);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last_tick = tokio::time::Instant::now();
    loop {
        tokio::select! {
            event = &mut answer, if held.is_none() => {
                let hold = watch.as_ref().filter(|watch| watch.holds).is_some_and(|watch| {
                    let mut activity = watch.lock();
                    // The answer closes the agent's reply; what it says after this is its reply to the work.
                    activity.reply_open = false;
                    activity.outliving()
                });
                if hold && !cancelled && matches!(event, DriverEvent::TurnCompleted { stop_reason: StopReason::Completed, .. }) {
                    held = Some(event);
                    answer = Box::pin(std::future::pending());
                    continue;
                }
                return Settled { event: with_usage(event, &extra), close, next: None };
            }
            Some(event) = superseded.next(), if !superseded.is_empty() => {
                if let DriverEvent::TurnCompleted { usage, .. } = &event {
                    extra.add(usage);
                }
            }
            Some(complete) = completions.recv() => {
                if held.is_none() && complete.prompt_id() == Some(prompt_id.as_str()) {
                    let event = complete.event(started.elapsed().as_millis() as u64);
                    return Settled { event: with_usage(event, &extra), close, next: None };
                }
            }
            now = tick.tick(), if watching && !cancelled => {
                let Some(watch) = watch.as_ref() else { continue };
                let mut activity = watch.lock();
                // A late tick is the host waking from sleep, not the agent's silence.
                if now.saturating_duration_since(last_tick) > WATCH_TICK + HOST_SLEEP_TOLERANCE || activity.busy() {
                    activity.last_progress = now;
                }
                last_tick = now;
                if let Some(event) = held.as_ref() {
                    if activity.released(now) {
                        drop(activity);
                        let mut event = with_usage(event.clone(), &extra);
                        if let DriverEvent::TurnCompleted { duration_ms, .. } = &mut event {
                            *duration_ms = started.elapsed().as_millis() as u64;
                        }
                        return Settled { event, close, next: None };
                    }
                } else if let Some(limit) = watch.inactivity
                    && now.saturating_duration_since(activity.last_progress) >= limit
                {
                    drop(activity);
                    control.cancel();
                    return Settled { event: (watch.silent)(), close, next: None };
                }
            }
            () = &mut deadline, if cancelled => {
                let duration_ms = started.elapsed().as_millis() as u64;
                let mut usage = extra.clone();
                if let Some(DriverEvent::TurnCompleted { usage: held, .. }) = &held {
                    usage.add(held);
                }
                let event = DriverEvent::TurnCompleted {
                    stop_reason: StopReason::Interrupted,
                    usage,
                    cost_usd: None,
                    duration_ms,
                    anchors: Default::default(),
                };
                return Settled { event, close, next: None };
            }
            command = commands.recv(), if !close => {
                match command {
                    Some(SessionCommand::Cancel) => control.cancel(),
                    Some(SessionCommand::Close) | None => {
                        control.cancel();
                        close = true;
                    }
                    // The agent's own reply ends here; the prompt goes next as a turn of its own.
                    Some(SessionCommand::Prompt { blocks }) if background && held.is_some() && !cancelled => {
                        let event = held.take().map(|event| with_usage(event, &extra)).expect("held");
                        return Settled { event, close, next: Some(blocks) };
                    }
                    Some(SessionCommand::Prompt { .. }) => continue,
                    Some(SessionCommand::Steer { blocks, reply }) => {
                        // A stopping turn takes no more input: the daemon sends it as a follow-up.
                        let next = if cancelled { None } else { control.steer(blocks) };
                        let sent = match next {
                            Some((id, next)) => {
                                prompt_id = id;
                                let replaced = std::mem::replace(&mut answer, next);
                                match held.take() {
                                    // The held prompt already answered: its usage is in hand.
                                    Some(DriverEvent::TurnCompleted { usage, .. }) => extra.add(&usage),
                                    Some(_) => {}
                                    None => superseded.push(replaced),
                                }
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

/// Wait for `load`, but count it done once a replay has started and been quiet for `idle_gap`; give up after
/// `timeout`. `None` for either turns that rule off.
pub(crate) async fn await_session_load<T>(
    load: impl Future<Output = T>,
    last_replay: &std::sync::Mutex<Option<tokio::time::Instant>>,
    idle_gap: Option<Duration>,
    timeout: Option<Duration>,
) -> LoadOutcome<T> {
    let mut load = std::pin::pin!(load);
    let mut deadline = std::pin::pin!(async {
        match timeout {
            Some(timeout) => tokio::time::sleep(timeout).await,
            None => std::future::pending().await,
        }
    });
    let mut tick = tokio::time::interval(Duration::from_millis(50));
    loop {
        tokio::select! {
            answered = &mut load => return LoadOutcome::Answered(answered),
            _ = &mut deadline => return LoadOutcome::TimedOut,
            _ = tick.tick() => {
                let quiet = idle_gap
                    .is_some_and(|gap| last_replay.lock().ok().and_then(|last| *last).is_some_and(|last| last.elapsed() >= gap));
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
