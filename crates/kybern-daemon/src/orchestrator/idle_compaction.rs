//! "Compact idle threads: Before the cache expires" (issue #295).
//!
//! When a turn ends on a thread above [`IDLE_COMPACTION_TOKENS`], the daemon
//! plans a compaction [`LEAD`] before the turn's prompt cache expires, so the
//! summary request still reads the cached history. At that moment it checks
//! the thread again and, if nothing changed, sends `/compact` through the
//! ordinary send path, which resumes a released session first. Nothing is
//! persisted: a restarted daemon plans again from the recorded expiry
//! ([`Orchestrator::resume_idle_compactions`]), and a window it missed is left
//! to the harness, as "When you return" would.
//!
//! The decision is [`plan`], a pure function of [`Facts`] and the time, so
//! every rule is tested without a clock or a session.

use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;

use anyhow::Result;
use chrono::{DateTime, Duration, Utc};
use kybern_protocol::*;

use super::{Orchestrator, is_compact_message};

/// Threads at or above this context size are compacted before their cache expires.
pub(super) const IDLE_COMPACTION_TOKENS: u64 = 200_000;
/// How long before the cache expires the compaction is sent.
pub(super) const LEAD: Duration = Duration::minutes(2);
/// The latest a compaction may start and still find the history cached.
pub(super) const LAST_CHANCE: Duration = Duration::seconds(30);

/// Harnesses Kybern can compact on its own schedule: they compact on request
/// and report (or let Kybern estimate) when their prompt cache expires.
pub(crate) fn supports_idle_compaction(kind: ProviderKind) -> bool {
    matches!(kind, ProviderKind::ClaudeCode | ProviderKind::Codex | ProviderKind::Opencode | ProviderKind::Pi | ProviderKind::Omp)
}

/// What [`plan`] needs to know about a thread.
#[derive(Debug, Clone)]
pub(super) struct Facts {
    pub mode: IdleCompaction,
    pub kind: ProviderKind,
    pub status: ThreadStatus,
    /// A provider subagent's, inbound proxy's, moved or Coordinator thread.
    pub excluded: bool,
    /// The latest turn and whether it was a compaction.
    pub latest_turn: Option<(TurnId, bool)>,
    /// An approval or question waits for the user.
    pub waiting_on_user: bool,
    /// Runtime tasks, delegated agents or queued messages will start the next turn.
    pub background_work: bool,
    /// The provider session the next message resumes, with its account.
    pub session: Option<(ProviderInstance, String)>,
    pub context_tokens: Option<u64>,
    pub cache_expires_at: Option<DateTime<Utc>>,
    pub cache_ttl_seconds: Option<u64>,
}

/// A compaction to send at `fire_at` unless the thread changed by then.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Plan {
    pub turn_id: TurnId,
    pub session: (ProviderInstance, String),
    pub fire_at: DateTime<Utc>,
    pub cache_expires_at: DateTime<Utc>,
    pub cache_ttl_seconds: Option<u64>,
    pub context_tokens: u64,
}

/// Why no compaction is planned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Skip {
    /// The setting is When you return or Never.
    Off,
    /// The harness cannot compact on Kybern's schedule.
    Unsupported,
    Excluded,
    Archived,
    /// The thread is running or waiting for an approval.
    Busy,
    /// The thread has no completed turn to follow.
    NoTurn,
    /// The latest turn was a compaction: one per idle spell.
    AlreadyCompacted,
    WaitingOnUser,
    BackgroundWork,
    /// Below [`IDLE_COMPACTION_TOKENS`], or the size is unknown.
    Small,
    NoSession,
    ExpiryUnknown,
    /// Too late to find the history cached.
    Missed,
    /// A newer turn started after the plan was made.
    NewerTurn,
    /// The thread moved to another session or account.
    OtherSession,
}

/// Plan the compaction for a thread whose turn just ended.
pub(super) fn plan(facts: &Facts, now: DateTime<Utc>) -> Result<Plan, Skip> {
    if facts.mode != IdleCompaction::BeforeCacheExpires {
        return Err(Skip::Off);
    }
    if !supports_idle_compaction(facts.kind) {
        return Err(Skip::Unsupported);
    }
    if facts.excluded {
        return Err(Skip::Excluded);
    }
    match facts.status {
        ThreadStatus::Archived => return Err(Skip::Archived),
        ThreadStatus::Running | ThreadStatus::AwaitingApproval => return Err(Skip::Busy),
        _ => {}
    }
    let Some((turn_id, was_compaction)) = facts.latest_turn else { return Err(Skip::NoTurn) };
    if was_compaction {
        return Err(Skip::AlreadyCompacted);
    }
    if facts.waiting_on_user {
        return Err(Skip::WaitingOnUser);
    }
    if facts.background_work {
        return Err(Skip::BackgroundWork);
    }
    let context_tokens = facts.context_tokens.filter(|tokens| *tokens >= IDLE_COMPACTION_TOKENS).ok_or(Skip::Small)?;
    let session = facts.session.clone().ok_or(Skip::NoSession)?;
    let cache_expires_at = facts.cache_expires_at.ok_or(Skip::ExpiryUnknown)?;
    if now >= cache_expires_at - LAST_CHANCE {
        return Err(Skip::Missed);
    }
    let fire_at = (cache_expires_at - LEAD).max(now);
    Ok(Plan { turn_id, session, fire_at, cache_expires_at, cache_ttl_seconds: facts.cache_ttl_seconds, context_tokens })
}

/// Whether `plan` still holds at `now`, when it is due.
pub(super) fn still_due(planned: &Plan, facts: &Facts, now: DateTime<Utc>) -> Result<(), Skip> {
    let current = plan(facts, now)?;
    if current.turn_id != planned.turn_id {
        return Err(Skip::NewerTurn);
    }
    if current.session != planned.session {
        return Err(Skip::OtherSession);
    }
    Ok(())
}

/// The documented cache lifetime of a harness that does not report one, in
/// seconds. Claude Code reports its own; Cursor, Antigravity and Grok Build
/// report nothing to estimate from.
pub(super) fn estimated_ttl_seconds(kind: ProviderKind, model: Option<&str>, env: &BTreeMap<String, String>) -> Option<u64> {
    const SHORT: u64 = 5 * 60;
    const LONG: u64 = 60 * 60;
    const CODEX: u64 = 30 * 60;
    let upstream = || model.and_then(|model| model.split_once('/')).map(|(provider, _)| provider.to_ascii_lowercase());
    let var = |key: &str| env.get(key).cloned().or_else(|| std::env::var(key).ok()).filter(|value| !value.trim().is_empty());
    match kind {
        ProviderKind::Codex => Some(CODEX),
        ProviderKind::Opencode => match upstream()?.as_str() {
            "anthropic" | "openai" => Some(SHORT),
            _ => None,
        },
        ProviderKind::Pi | ProviderKind::Omp => {
            // `PI_CACHE_RETENTION` (both) or OMP's `auto`: Anthropic keeps 1 h on a
            // subscription sign-in and 5 min on an API key. Pi defaults to short.
            let default = if kind == ProviderKind::Omp { "auto" } else { "short" };
            let retention = var("PI_CACHE_RETENTION").unwrap_or_else(|| default.into()).to_ascii_lowercase();
            match (upstream()?.as_str(), retention.as_str()) {
                (_, "none") => None,
                ("anthropic", "long") => Some(LONG),
                ("anthropic", "auto") if var("ANTHROPIC_API_KEY").is_none() => Some(LONG),
                ("anthropic", _) => Some(SHORT),
                ("openai-codex", _) => Some(CODEX),
                ("openai", _) => Some(SHORT),
                _ => None,
            }
        }
        _ => None,
    }
}

/// Planned compactions by thread: at most one timer each. A new plan replaces
/// the old one's timer; a new turn or archiving the thread cancels it; a timer
/// that fires takes itself out before it sends.
#[derive(Default)]
pub(super) struct IdleCompactions {
    timers: Mutex<HashMap<ThreadId, (u64, tokio::task::JoinHandle<()>)>>,
    generation: std::sync::atomic::AtomicU64,
}

impl IdleCompactions {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<ThreadId, (u64, tokio::task::JoinHandle<()>)>> {
        self.timers.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// A number for the next timer, so a firing timer removes only itself.
    fn next_generation(&self) -> u64 {
        self.generation.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    }

    fn replace(&self, thread_id: ThreadId, timer: Option<(u64, tokio::task::JoinHandle<()>)>) {
        let old = match timer {
            Some(timer) => self.lock().insert(thread_id, timer),
            None => self.lock().remove(&thread_id),
        };
        if let Some((_, old)) = old {
            old.abort();
        }
    }

    /// Drop the thread's planned compaction: a turn started, or the thread was archived.
    pub(super) fn cancel(&self, thread_id: ThreadId) {
        self.replace(thread_id, None);
    }

    /// A due timer leaves the map without aborting itself; a newer plan stays.
    fn take_due(&self, thread_id: ThreadId, generation: u64) -> bool {
        let mut timers = self.lock();
        if timers.get(&thread_id).is_some_and(|(current, _)| *current == generation) {
            timers.remove(&thread_id);
            return true;
        }
        false
    }

    #[cfg(test)]
    pub(super) fn planned(&self, thread_id: ThreadId) -> bool {
        self.lock().get(&thread_id).is_some_and(|(_, timer)| !timer.is_finished())
    }
}

impl Orchestrator {
    /// Compaction settings a new session of this account launches with.
    pub(super) fn compaction_launch(&self, provider: &ProviderInstance) -> kybern_drivers::CompactionLaunch {
        let settings = self.inner.settings.get();
        kybern_drivers::CompactionLaunch {
            auto_compact_tokens: settings.compaction.auto_compact_tokens.get(&provider.kind).copied(),
            decline_resume_prompt: settings.idle_compaction_for(provider) == IdleCompaction::Never,
        }
    }

    /// The prompt cache a harness that reports none left, from its documented
    /// lifetime, counted from the end of the turn.
    pub(super) fn estimated_prompt_cache(&self, thread: &Thread) -> Option<PromptCache> {
        let kind = thread.provider.kind;
        if kind == ProviderKind::ClaudeCode {
            return None;
        }
        let settings = self.inner.settings.get();
        let provider = settings.providers.get(&kind).cloned().unwrap_or_default();
        let mut env = provider.env.clone();
        if let Ok(account) = crate::provider_accounts::environment(&provider, kind, &thread.provider.instance) {
            env.extend(account);
        }
        let ttl = estimated_ttl_seconds(kind, thread.model.as_deref(), &env)?;
        Some(PromptCache::from_request(ttl, Utc::now(), true))
    }

    /// Everything [`plan`] reads, from the store and the live session.
    pub(super) async fn idle_compaction_facts(&self, thread_id: ThreadId) -> Result<Facts> {
        let thread = self.inner.store.thread_get(thread_id)?.ok_or_else(|| anyhow::anyhow!("thread not found"))?;
        let mode = self.inner.settings.get().idle_compaction_for(&thread.provider);
        let usage = self.inner.store.provider_usage_through(thread_id, EventSeq::MAX)?;
        let mut facts = Facts {
            mode,
            kind: thread.provider.kind,
            status: thread.status,
            // Subagents and inbound proxies take no messages here, a moved thread lives on
            // elsewhere, and Coordinators refresh their context instead.
            excluded: thread.subagent.is_some()
                || thread.coordinator_project_id.is_some()
                || thread.inbound.is_some()
                || thread.moved.is_some(),
            latest_turn: None,
            waiting_on_user: false,
            background_work: false,
            session: thread.provider_session_id.clone().map(|id| (thread.provider.clone(), id)),
            context_tokens: usage.context.map(|context| context.used_tokens),
            cache_expires_at: usage.prompt_cache.as_ref().and_then(|cache| cache.expires_at),
            cache_ttl_seconds: usage.prompt_cache.as_ref().and_then(|cache| cache.ttl_seconds),
        };
        // The cheap facts already rule most threads out; read the history only for the rest.
        if mode != IdleCompaction::BeforeCacheExpires || facts.context_tokens.is_none_or(|tokens| tokens < IDLE_COMPACTION_TOKENS) {
            return Ok(facts);
        }
        let events = self.inner.store.events_for_thread(thread_id)?;
        facts.latest_turn = events.iter().rev().find_map(|event| match &event.payload {
            EventPayload::TurnStarted { message, .. } => event.turn_id.map(|turn_id| (turn_id, is_compact_message(message))),
            _ => None,
        });
        let live_tasks = match self.inner.sessions.lock().await.get(&thread_id).cloned() {
            Some(live) => live.tasks.lock().await.values().any(|task| task.status.is_active()),
            None => false,
        };
        facts.waiting_on_user = !kybern_store::project_pending_questions(&events).is_empty();
        facts.background_work = live_tasks
            || self.is_rotating(thread_id)
            || kybern_store::project_runtime_tasks(&events).iter().any(|task| task.status.is_active())
            || !self.inner.store.queue_list(Some(thread_id))?.is_empty()
            || self.inner.store.delegation_children(thread_id)?.iter().any(|child| {
                child.status != ThreadStatus::Archived
                    && child.delegation.as_ref().is_some_and(|info| info.status == DelegationStatus::Running)
            });
        Ok(facts)
    }

    /// After a turn ends: plan the thread's idle compaction, or drop an old plan.
    pub(super) fn schedule_idle_compaction(&self, thread_id: ThreadId) {
        let this = self.clone();
        tokio::spawn(async move {
            let decision = match this.idle_compaction_facts(thread_id).await {
                Ok(facts) => plan(&facts, Utc::now()),
                Err(error) => {
                    tracing::debug!(%thread_id, %error, "could not plan an idle compaction");
                    return;
                }
            };
            match decision {
                Ok(planned) => {
                    tracing::debug!(%thread_id, fire_at = %planned.fire_at, "planned an idle compaction");
                    let runner = this.clone();
                    let generation = this.inner.idle_compactions.next_generation();
                    // Hold the timer until it is in the map, so it can always find itself there.
                    let (registered, ready) = tokio::sync::oneshot::channel::<()>();
                    let timer = tokio::spawn(async move {
                        if ready.await.is_err() {
                            return;
                        }
                        let wait = (planned.fire_at - Utc::now()).to_std().unwrap_or_default();
                        tokio::time::sleep(wait).await;
                        // Out of the map before sending: the send's own turn start cancels
                        // planned compactions and must not abort this task mid-way.
                        if !runner.inner.idle_compactions.take_due(thread_id, generation) {
                            return;
                        }
                        if let Err(error) = runner.run_idle_compaction(thread_id, &planned, Utc::now()).await {
                            tracing::warn!(%thread_id, %error, "the idle compaction did not start");
                        }
                    });
                    this.inner.idle_compactions.replace(thread_id, Some((generation, timer)));
                    let _ = registered.send(());
                }
                Err(_) => this.inner.idle_compactions.replace(thread_id, None),
            }
        });
    }

    /// Send the planned compaction if the thread is as it was. `Ok(None)`: skipped.
    pub(super) async fn run_idle_compaction(&self, thread_id: ThreadId, planned: &Plan, now: DateTime<Utc>) -> Result<Option<TurnId>> {
        let facts = self.idle_compaction_facts(thread_id).await?;
        if let Err(skip) = still_due(planned, &facts, now) {
            tracing::debug!(%thread_id, ?skip, "skipped the idle compaction");
            return Ok(None);
        }
        let (turn_id, _) = self.send(thread_id, UserMessage::text("/compact")).await?;
        self.emit(
            thread_id,
            Some(turn_id),
            EventPayload::IdleCompactionStarted {
                context_tokens: planned.context_tokens,
                cache_expires_at: planned.cache_expires_at,
                cache_ttl_seconds: planned.cache_ttl_seconds,
            },
        )?;
        Ok(Some(turn_id))
    }

    /// After a restart, plan again for idle threads whose cache is still warm.
    /// A window that already passed is left to the harness.
    pub async fn resume_idle_compactions(&self) -> Result<()> {
        let settings = self.inner.settings.get();
        let anyone_opted_in = settings.compaction.idle == IdleCompaction::BeforeCacheExpires
            || settings
                .providers
                .values()
                .any(|provider| provider.idle_compaction.values().any(|mode| *mode == IdleCompaction::BeforeCacheExpires));
        if !anyone_opted_in {
            return Ok(());
        }
        let recent = Utc::now() - Duration::hours(2);
        for thread in self.inner.store.threads_list(None, false)? {
            if thread.status == ThreadStatus::Idle && thread.updated_at >= recent && supports_idle_compaction(thread.provider.kind) {
                self.schedule_idle_compaction(thread.id);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "idle_compaction_tests.rs"]
mod tests;
