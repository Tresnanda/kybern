//! A turn moving to a new session: the one guard every recovery that sends a turn again shares.
//!
//! Recoveries end a session in the middle of a turn and send the same message to a new one: Claude Code lost
//! the conversation ([`ResendReason::MissingConversation`], `claude_sessions.rs`), a lent login was rejected
//! ([`ResendReason::RejectedLogin`], `login_borrow.rs`). Between the two sessions there is no live turn to
//! interrupt, so the turn's end belongs to whoever claims it first:
//!
//! * the resend, right before the new session gets the message ([`ResendOutcome::Sent`]); from then on the
//!   new session's own events end the turn, and Stop interrupts it like any other;
//! * Stop ([`Orchestrator::stop_resend`]), a failed resend ([`ResendGuard::fail`]), a newer turn
//!   ([`Orchestrator::supersede_resend`]) or the guard dropped on an early return or a panic, which all end it
//!   ([`ResendOutcome::Ended`]).
//!
//! The guard lives in memory only and is keyed by turn: nothing outlives the daemon, and a turn's end is
//! emitted for that turn alone, never for one that started later. Every check is a compare-and-set on the
//! entry, so a Stop and a resend can't both act on the same turn.

use super::*;
use tokio::sync::watch;

/// Why a turn is sent again on a new session.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ResendReason {
    /// Claude Code no longer has the conversation the session resumed.
    MissingConversation,
    /// The login another machine lent was rejected; a fresh one is borrowed first.
    RejectedLogin,
}

/// Who owns the turn's end.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ResendOutcome {
    /// Between two sessions: nothing has claimed the turn yet.
    Pending,
    /// The new session got the message; its events end the turn.
    Sent,
    /// The turn ended without being sent (Stop, a failure, a newer turn, an early return).
    Ended,
}

/// One thread's turn between two sessions.
pub(super) struct ResendEntry {
    turn_id: TurnId,
    reason: ResendReason,
    outcome: watch::Sender<ResendOutcome>,
    /// Stop came after the turn was claimed for sending, while the message was on its way: the new session
    /// is interrupted as soon as it has it (an interrupt that reaches it before the message would be lost).
    stop_requested: AtomicBool,
}

impl ResendEntry {
    pub(super) fn turn_id(&self) -> TurnId {
        self.turn_id
    }

    /// Claim the turn's end for `to`. Only the first claim wins.
    pub(super) fn claim(&self, to: ResendOutcome) -> bool {
        self.outcome.send_if_modified(|outcome| {
            if *outcome != ResendOutcome::Pending {
                return false;
            }
            *outcome = to;
            true
        })
    }

    pub(super) fn outcome(&self) -> ResendOutcome {
        *self.outcome.borrow()
    }

    pub(super) fn is_pending(&self) -> bool {
        self.outcome() == ResendOutcome::Pending
    }
}

/// Every thread whose turn is between two sessions (`Inner::resends`).
#[derive(Default)]
pub(super) struct Resends(std::sync::Mutex<HashMap<ThreadId, Arc<ResendEntry>>>);

impl Resends {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<ThreadId, Arc<ResendEntry>>> {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(super) fn get(&self, thread_id: ThreadId) -> Option<Arc<ResendEntry>> {
        self.lock().get(&thread_id).cloned()
    }

    /// Remove `entry` if it is still the thread's.
    fn remove(&self, thread_id: ThreadId, entry: &Arc<ResendEntry>) {
        let mut entries = self.lock();
        if entries.get(&thread_id).is_some_and(|current| Arc::ptr_eq(current, entry)) {
            entries.remove(&thread_id);
        }
    }

    #[cfg(test)]
    pub(super) fn is_empty(&self) -> bool {
        self.lock().is_empty()
    }
}

/// Held by the task that sends a turn again. Dropping it without a claim (an early return, a panic) ends the
/// turn as interrupted, so a turn never stays running with nobody to end it.
pub(super) struct ResendGuard {
    orchestrator: Orchestrator,
    thread_id: ThreadId,
    entry: Arc<ResendEntry>,
}

impl ResendGuard {
    pub(super) fn entry(&self) -> &Arc<ResendEntry> {
        &self.entry
    }

    pub(super) fn reason(&self) -> ResendReason {
        self.entry.reason
    }

    /// Whether the turn still waits to be sent: nothing stopped or ended it meanwhile.
    pub(super) fn is_pending(&self) -> bool {
        self.entry.is_pending()
    }

    /// The resend failed before the new session got the message: the turn fails with `error`, unless Stop or
    /// something else ended it first. Returns whether this failed it.
    pub(super) fn fail(self, error: String, problem: Option<kybern_protocol::rpc::Problem>) -> bool {
        if !self.entry.claim(ResendOutcome::Ended) {
            return false;
        }
        self.orchestrator.inner.resends.remove(self.thread_id, &self.entry);
        self.orchestrator.end_resent_turn(
            self.thread_id,
            self.entry.turn_id,
            ResentTurnEnd::Failed { error, problem: problem.map(Box::new) },
        );
        true
    }
}

impl Drop for ResendGuard {
    fn drop(&mut self) {
        self.orchestrator.inner.resends.remove(self.thread_id, &self.entry);
        if self.entry.claim(ResendOutcome::Ended) {
            tracing::info!(thread_id = %self.thread_id, turn_id = %self.entry.turn_id, reason = ?self.entry.reason, "a resend ended without sending its turn");
            self.orchestrator.end_resent_turn(self.thread_id, self.entry.turn_id, ResentTurnEnd::Interrupted);
        }
    }
}

/// How a turn that was never sent again ends.
pub(super) enum ResentTurnEnd {
    Interrupted,
    Failed { error: String, problem: Option<Box<kybern_protocol::rpc::Problem>> },
}

/// A recovery decided while the failed turn still held `live.turn`, so a Stop can't fall between the two;
/// [`Orchestrator::run_resend`] carries it out once `live.turn` is released.
pub(super) struct PlannedResend {
    pub(super) guard: ResendGuard,
    pub(super) message_id: MessageId,
    pub(super) message: UserMessage,
    /// Borrowing the login again before the turn is sent ([`ResendReason::RejectedLogin`]), for the harness
    /// that names its failure.
    pub(super) login: Option<(ProviderKind, LoginRenewal)>,
}

/// `LoginBroker::renew` for one account; its error is the sentence the turn fails with.
pub(super) type LoginRenewal = std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send>>;

/// `meta` keys of the persisted markers the guard replaced (0.25.x development builds).
const RETIRED_META_PREFIXES: [&str; 2] = ["resend:", "resend_stopped:"];

impl Orchestrator {
    /// The turn `turn_id` of `thread_id` is about to move to a new session. Register it before the old session
    /// lets go of the turn, so a Stop in between finds it.
    pub(super) fn begin_resend(&self, thread_id: ThreadId, turn_id: TurnId, reason: ResendReason) -> ResendGuard {
        let (outcome, _) = watch::channel(ResendOutcome::Pending);
        let entry = Arc::new(ResendEntry { turn_id, reason, outcome, stop_requested: AtomicBool::new(false) });
        let previous = self.inner.resends.lock().insert(thread_id, entry.clone());
        // A resend nobody settled: the same turn's is replaced by this one (its task then sends nothing), an
        // older turn's is not this thread's turn any more.
        if let Some(previous) = previous
            && previous.claim(ResendOutcome::Ended)
            && previous.turn_id != turn_id
        {
            self.end_superseded_turn(thread_id, previous.turn_id);
        }
        ResendGuard { orchestrator: self.clone(), thread_id, entry }
    }

    /// Stop for a thread whose turn may be between two sessions. Returns whether Stop is done: the turn was
    /// ended here, or had already ended. `false` when there is no resend for the thread's current running turn
    /// (none at all, a stale one, or one the new session already holds): Stop goes on to the live session.
    pub(super) fn stop_resend(&self, thread_id: ThreadId) -> bool {
        let Some(entry) = self.inner.resends.get(thread_id) else { return false };
        if !self.turn_is_current(thread_id, entry.turn_id) {
            // Not the turn that runs now: nothing to report through it.
            tracing::info!(%thread_id, turn_id = %entry.turn_id, "dropping a resend for a turn that no longer runs");
            entry.claim(ResendOutcome::Ended);
            self.inner.resends.remove(thread_id, &entry);
            return false;
        }
        if entry.claim(ResendOutcome::Ended) {
            tracing::info!(%thread_id, turn_id = %entry.turn_id, reason = ?entry.reason, "stopped a turn waiting for its new session");
            self.inner.resends.remove(thread_id, &entry);
            self.end_resent_turn(thread_id, entry.turn_id, ResentTurnEnd::Interrupted);
            return true;
        }
        match entry.outcome() {
            // The new session holds the turn: Stop interrupts it like any other, and once more as soon as the
            // message is delivered (`resend_delivered`).
            ResendOutcome::Sent => {
                entry.stop_requested.store(true, Ordering::SeqCst);
                false
            }
            // Ended by someone else a moment ago.
            ResendOutcome::Ended | ResendOutcome::Pending => true,
        }
    }

    /// A new turn starts: a resend still waiting for an older turn loses it. Its turn ends as interrupted;
    /// the thread's status is the new turn's.
    pub(super) fn supersede_resend(&self, thread_id: ThreadId, turn_id: TurnId) {
        let Some(entry) = self.inner.resends.get(thread_id).filter(|entry| entry.turn_id != turn_id) else { return };
        self.inner.resends.remove(thread_id, &entry);
        if entry.claim(ResendOutcome::Ended) {
            tracing::info!(%thread_id, old = %entry.turn_id, new = %turn_id, "a new turn replaced one waiting for its new session");
            self.end_superseded_turn(thread_id, entry.turn_id);
        }
    }

    /// The resent turn reached the point of sending: claim it for the new session. `false` when Stop or
    /// something else ended it first; the caller then sends nothing. The entry stays until
    /// [`Self::resend_delivered`], so a Stop while the message is on its way is not lost.
    pub(super) fn resend_commit(&self, entry: &ResendEntry) -> bool {
        entry.claim(ResendOutcome::Sent)
    }

    /// The new session took the message (`delivered`) or failed to. Returns whether a Stop came while it was
    /// on its way, so the caller interrupts the turn now that there is one to interrupt.
    pub(super) fn resend_delivered(&self, thread_id: ThreadId, entry: &Arc<ResendEntry>, delivered: bool) -> bool {
        self.inner.resends.remove(thread_id, entry);
        delivered && entry.stop_requested.load(Ordering::SeqCst)
    }

    /// Whether `turn_id` is `thread_id`'s latest turn, not ended, and the thread is running it.
    pub(super) fn turn_is_current(&self, thread_id: ThreadId, turn_id: TurnId) -> bool {
        let running = self
            .inner
            .store
            .thread_get(thread_id)
            .ok()
            .flatten()
            .is_some_and(|thread| matches!(thread.status, ThreadStatus::Running | ThreadStatus::AwaitingApproval));
        if !running {
            return false;
        }
        let Ok(events) = self.inner.store.latest_turn_quota_events(thread_id) else { return false };
        let latest = events.iter().find(|event| matches!(event.payload, EventPayload::TurnStarted { .. })).and_then(|event| event.turn_id);
        latest == Some(turn_id)
            && !events.iter().any(|event| {
                event.turn_id == Some(turn_id)
                    && matches!(event.payload, EventPayload::TurnCompleted { .. } | EventPayload::TurnFailed { .. })
            })
    }

    /// End a turn that was never sent again: only while it is the thread's current turn, so a late resend
    /// can't end a turn that started after it.
    pub(super) fn end_resent_turn(&self, thread_id: ThreadId, turn_id: TurnId, end: ResentTurnEnd) {
        if !self.turn_is_current(thread_id, turn_id) {
            tracing::debug!(%thread_id, %turn_id, "the resent turn is no longer the thread's; nothing to end");
            return;
        }
        let (payload, status, outcome) = match end {
            ResentTurnEnd::Interrupted => (
                EventPayload::TurnCompleted {
                    stop_reason: StopReason::Interrupted,
                    usage: Usage::default(),
                    cost_usd: None,
                    duration_ms: 0,
                    terminal_message_id: None,
                },
                ThreadStatus::Idle,
                delegation::TurnOutcome::Completed { stop_reason: StopReason::Interrupted, terminal_message_id: None },
            ),
            ResentTurnEnd::Failed { error, problem } => (
                EventPayload::TurnFailed { error: error.clone(), problem: problem.map(|problem| *problem) },
                ThreadStatus::Failed,
                delegation::TurnOutcome::Failed(error),
            ),
        };
        if let Err(error) = self.emit(thread_id, Some(turn_id), payload) {
            tracing::warn!(%thread_id, %turn_id, %error, "could not end the resent turn");
            return;
        }
        if let Ok(Some(mut thread)) = self.inner.store.thread_get(thread_id) {
            thread.status = status;
            if let Err(error) = self.update_thread(thread) {
                tracing::warn!(%thread_id, %error, "could not settle the thread after its resent turn");
            }
        }
        self.delegation_turn_finished(thread_id, turn_id, outcome);
        self.inner.queue_wakeup.notify_one();
    }

    /// An older turn lost its resend to a newer one: its row ends as interrupted, the thread stays as it is.
    fn end_superseded_turn(&self, thread_id: ThreadId, turn_id: TurnId) {
        let ended = EventPayload::TurnCompleted {
            stop_reason: StopReason::Interrupted,
            usage: Usage::default(),
            cost_usd: None,
            duration_ms: 0,
            terminal_message_id: None,
        };
        if let Err(error) = self.emit(thread_id, Some(turn_id), ended) {
            tracing::warn!(%thread_id, %turn_id, %error, "could not end a superseded resend's turn");
        }
    }

    /// Carry out `plan`: let go of the old session, close it, borrow the login again when the plan says so,
    /// and send the turn to a new session unless Stop ended it meanwhile. Call without holding `live.turn`:
    /// this takes `sessions`, which `force_interrupt` takes before `live.turn`.
    pub(super) async fn run_resend(&self, thread_id: ThreadId, live: &Arc<LiveSession>, plan: PlannedResend) {
        {
            let mut sessions = self.inner.sessions.lock().await;
            if sessions.get(&thread_id).is_some_and(|current| Arc::ptr_eq(current, live)) {
                sessions.remove(&thread_id);
            }
        }
        live.mark_released();
        self.revoke_native_session(live);
        let (this, live) = (self.clone(), live.clone());
        tokio::spawn(async move {
            let PlannedResend { guard, message_id, message, login } = plan;
            // Stdin is closed and the process left to finish: killing Claude mid-refresh loses its tokens.
            if let Err(error) = live.session.close().await {
                tracing::debug!(%error, %thread_id, reason = ?guard.reason(), "closing the session a turn leaves failed");
            }
            if let Some((kind, renew)) = login
                && let Err(text) = renew.await
            {
                // A Stop while the login was renewed already ended the turn; otherwise it fails with the borrow.
                let problem = kybern_drivers::failure::classify(kind, &text);
                guard.fail(text, problem);
                return;
            }
            if !guard.is_pending() {
                return;
            }
            // Archived or gone meanwhile: dropping the guard settles what is left.
            let running = |thread: &Thread| matches!(thread.status, ThreadStatus::Running | ThreadStatus::AwaitingApproval);
            let Some(thread) = this.inner.store.thread_get(thread_id).ok().flatten().filter(running) else { return };
            // start_turn reports its own failures; one that returns before sending leaves the guard to end the turn.
            if let Err(error) = this.start_resent_turn(&guard, thread, message_id, message).await {
                tracing::info!(%thread_id, %error, reason = ?guard.reason(), "the new session could not take the turn");
            }
        });
    }

    /// `start_turn` for a resent turn, behind a boxed future: a session's event pump reaches the recovery,
    /// which restarts the turn, which spawns a session with a pump; erasing the type here ends that cycle.
    pub(super) fn start_resent_turn<'a>(
        &'a self,
        guard: &ResendGuard,
        thread: Thread,
        message_id: MessageId,
        message: UserMessage,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + 'a>> {
        let entry = guard.entry().clone();
        Box::pin(self.start_turn_with(thread, entry.turn_id(), message_id, message, std::time::Instant::now(), Some(entry)))
    }

    /// Remove the persisted resend markers earlier builds wrote; the guard keeps them in memory now.
    pub(super) fn forget_retired_resend_markers(&self) {
        for prefix in RETIRED_META_PREFIXES {
            if let Err(error) = self.inner.store.meta_delete_prefix(prefix) {
                tracing::warn!(%error, prefix, "could not remove retired resend markers");
            }
        }
    }
}
