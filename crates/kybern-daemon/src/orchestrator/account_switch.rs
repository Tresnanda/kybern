//! Several accounts for more limit: which account a limited thread could continue on,
//! waiting for the thread's own account to reset, and a thread whose account is not usable
//! on this machine.
//!
//! Kybern never moves a thread to another account by itself (decision Q30: Anthropic's and
//! OpenAI's terms forbid rotating accounts to get around limits). It suggests one, the person
//! taps, and the switch is recorded as `AccountSwitched`.
//!
//! An account is eligible when it is the thread's harness, usable on this machine (signed in
//! here, or borrowed from a machine that answers), and not marked "Only when I choose"
//! (`Settings.accounts_shared.profiles`). The suggestion is the eligible account with the most
//! limit left in the window that ran out, skipping accounts at 90% or more of their weekly
//! limit. A limited thread whose own reset time is known also waits for it and continues on its
//! own account; the wait is kept in `account_wait:<thread>` so it survives a restart, and
//! `threads.interrupt`, a new message or a switch cancels it.
use super::*;
use anyhow::ensure;
use chrono::DateTime;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::BTreeMap;

/// How long a sign-in probe answers for an account.
const PROBE_FRESH: Duration = Duration::from_secs(5 * 60);
/// A probe that takes longer than this counts as "can't tell".
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
/// Accounts at or above this share of their weekly limit are not suggested.
const WEEKLY_NEAR_PERCENT: f64 = 90.0;
/// Continue this long after the reset, so the provider has counted it.
const WAIT_MARGIN_SECONDS: i64 = 60;
const FIVE_HOURS: u64 = 300;
const WEEK: u64 = 10080;

#[derive(Default)]
pub(super) struct SwitchState {
    probes: std::sync::Mutex<HashMap<(ProviderKind, String), Probe>>,
    pub(super) waits: std::sync::Mutex<HashMap<ThreadId, tokio::task::AbortHandle>>,
    /// Threads whose limit recovery is being decided, so two settled events never both act.
    deciding: std::sync::Mutex<HashSet<ThreadId>>,
}

#[derive(Clone)]
struct Probe {
    at: Instant,
    usable: bool,
    email: Option<String>,
}

/// A scheduled continuation after a reset.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(super) struct PendingWait {
    pub until: DateTime<Utc>,
    pub account: ProviderInstance,
    pub message_id: MessageId,
}

/// One account of the thread's harness, as the switcher sees it.
#[derive(Debug, Clone)]
pub(super) struct Candidate {
    pub instance: String,
    pub usable: bool,
    pub manual_only: bool,
    pub limits: Vec<UsageLimit>,
}

/// How a continuation came about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Continuation {
    /// The person chose another account (one tap, or an explicit account).
    Manual,
    /// The thread's own account reset after a wait.
    AfterWait,
}

fn full(limit: &UsageLimit, now: i64) -> bool {
    limit.used_percent >= 100.0
        && matches!(limit.window_minutes, Some(FIVE_HOURS | WEEK))
        && limit.resets_at.is_none_or(|reset| reset > now)
}

fn near_weekly(limit: &UsageLimit, now: i64) -> bool {
    limit.window_minutes == Some(WEEK) && limit.used_percent >= WEEKLY_NEAR_PERCENT && limit.resets_at.is_none_or(|reset| reset > now)
}

/// Limit left in `window` (or in the tightest of the 5-hour and weekly windows), in percent.
fn headroom(limits: &[UsageLimit], window: Option<u64>) -> Option<f64> {
    let left = |limit: &UsageLimit| (100.0 - limit.used_percent).max(0.0);
    match window {
        Some(window) => limits.iter().find(|limit| limit.window_minutes == Some(window)).map(left),
        None => {
            limits.iter().filter(|limit| matches!(limit.window_minutes, Some(FIVE_HOURS | WEEK))).map(left).min_by(|a, b| a.total_cmp(b))
        }
    }
}

/// The eligible account with the most limit left in `ran_out` (accounts whose limits
/// were never read come after every account known to have room). `current` and
/// `exclude` are never suggested.
pub(super) fn pick_suggestion(
    current: &str,
    ran_out: Option<u64>,
    candidates: &[Candidate],
    now: i64,
    exclude: &[String],
) -> Option<String> {
    let mut best: Option<(bool, f64, &str)> = None;
    for candidate in candidates {
        if candidate.instance == current || !candidate.usable || candidate.manual_only || exclude.contains(&candidate.instance) {
            continue;
        }
        if candidate.limits.iter().any(|limit| full(limit, now) || near_weekly(limit, now)) {
            continue;
        }
        let (known, left) = match headroom(&candidate.limits, ran_out).or_else(|| headroom(&candidate.limits, None)) {
            Some(left) if left <= 0.0 => continue,
            Some(left) => (true, left),
            None => (false, 0.0),
        };
        if best.is_none_or(|(best_known, best_left, _)| (known, left) > (best_known, best_left)) {
            best = Some((known, left, &candidate.instance));
        }
    }
    best.map(|(_, _, instance)| instance.to_string())
}

/// The window that ran out on `limits`: the full one that resets last.
pub(super) fn ran_out_window(limits: &[UsageLimit], error: Option<&str>, now: i64) -> Option<u64> {
    limits
        .iter()
        .filter(|limit| full(limit, now))
        .max_by_key(|limit| limit.resets_at.unwrap_or(i64::MAX))
        .and_then(|limit| limit.window_minutes)
        .or_else(|| {
            let text = error?.to_ascii_lowercase();
            if text.contains("week") {
                Some(WEEK)
            } else if text.contains("5-hour") || text.contains("5 hour") || text.contains("five-hour") {
                Some(FIVE_HOURS)
            } else {
                None
            }
        })
}

/// When the thread's own account can run again (with the margin): the latest reset among its
/// full windows. `None` when nothing is full or a full window's reset is unknown.
pub(super) fn own_reset(limits: &[UsageLimit], now: i64) -> Option<i64> {
    let blocking = limits.iter().filter(|limit| full(limit, now)).collect::<Vec<_>>();
    if blocking.is_empty() || blocking.iter().any(|limit| limit.resets_at.is_none()) {
        return None;
    }
    blocking.iter().filter_map(|limit| limit.resets_at).max().map(|ready| ready + WAIT_MARGIN_SECONDS)
}

impl Orchestrator {
    fn wait_key(thread_id: ThreadId) -> String {
        format!("account_wait:{thread_id}")
    }

    /// The thread's harness accounts on this machine: the terminal login and every named one.
    fn switch_instances(&self, kind: ProviderKind) -> Vec<String> {
        if kind == ProviderKind::GrokBuild {
            return vec!["default".into()];
        }
        let settings = self.inner.settings.get();
        std::iter::once("default".to_string())
            .chain(settings.providers.get(&kind).into_iter().flat_map(|provider| provider.accounts.keys().cloned()))
            .collect()
    }

    fn account_email(&self, provider: &ProviderInstance) -> Option<String> {
        let settings = self.inner.settings.get();
        settings
            .providers
            .get(&provider.kind)
            .and_then(|settings| settings.accounts.get(&provider.instance))
            .and_then(|account| account.email.clone())
            .or_else(|| self.cached_probe(provider).and_then(|probe| probe.email))
            // The terminal login's email from its last probe, and a borrowed account's lender account: "Only
            // when I choose" holds for them too, even when no recent probe here said who they are (#20).
            .or_else(|| {
                (provider.instance == "default").then(|| crate::accounts_shared::terminal_email(&self.inner.store, provider.kind)).flatten()
            })
            .or_else(|| self.borrowed_email(provider))
    }

    /// The email of the lender's account a borrowed account signs in through, from the lender's holdings.
    fn borrowed_email(&self, provider: &ProviderInstance) -> Option<String> {
        let broker = self.login_broker()?;
        let account = broker.binding(provider.kind, &provider.instance)?;
        let machine = broker.lender_for(provider.kind)?;
        let key = crate::network::accounts_sync::holding_key(&self.inner.store, &machine, provider.kind, &account)?;
        crate::accounts_shared::parse_key(&key).map(|(_, email)| email.to_string())
    }

    /// The name a person knows the account by.
    pub(super) fn account_label(&self, provider: &ProviderInstance) -> String {
        let settings = self.inner.settings.get();
        if let Some(account) = settings.providers.get(&provider.kind).and_then(|settings| settings.accounts.get(&provider.instance)) {
            return account.name.clone();
        }
        let email = self.account_email(provider);
        if let Some(profile) = email
            .as_deref()
            .and_then(|email| settings.accounts_shared.profiles.get(&AccountsShared::key(provider.kind, email)))
            .filter(|profile| !profile.name.trim().is_empty())
        {
            return profile.name.clone();
        }
        email.unwrap_or_else(|| format!("{} terminal login", provider.kind.display_name()))
    }

    fn manual_only(&self, provider: &ProviderInstance) -> bool {
        self.inner.settings.get().accounts_shared.manual_only(provider.kind, self.account_email(provider).as_deref())
    }

    fn cached_probe(&self, provider: &ProviderInstance) -> Option<Probe> {
        self.inner
            .account_switch
            .probes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&(provider.kind, provider.instance.clone()))
            .filter(|probe| probe.at.elapsed() < PROBE_FRESH)
            .cloned()
    }

    fn remember_probe(&self, provider: &ProviderInstance, usable: bool, email: Option<String>) {
        self.inner
            .account_switch
            .probes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert((provider.kind, provider.instance.clone()), Probe { at: Instant::now(), usable, email });
    }

    #[cfg(test)]
    pub(super) fn set_probe_for_test(&self, provider: &ProviderInstance, usable: bool, email: Option<&str>) {
        self.remember_probe(provider, usable, email.map(str::to_string));
    }

    /// Why the account cannot be used on this machine, from what is known without starting
    /// anything: it is not set up here, it was signed out, or it borrows its login from a
    /// machine that does not answer. A sentence, for errors and offers.
    pub(super) fn unavailable_reason(&self, provider: &ProviderInstance) -> Option<String> {
        let settings = self.inner.settings.get();
        if provider.instance != "default"
            && settings.providers.get(&provider.kind).is_none_or(|settings| !settings.accounts.contains_key(&provider.instance))
        {
            return Some(format!("This {} account isn't set up on this machine.", provider.kind.display_name()));
        }
        if self.ensure_account_signed_in(provider).is_err() {
            return Some(format!("{} is signed out on this machine.", self.account_label(provider)));
        }
        let view = self.login_broker().and_then(|broker| broker.account_view(provider.kind, &provider.instance))?;
        (!matches!(view.state, BrokerLoginState::Borrowing | BrokerLoginState::Lending)).then(|| {
            view.message.unwrap_or_else(|| {
                format!("{} borrows its sign-in from {}, which doesn't answer.", self.account_label(provider), view.machine_name)
            })
        })
    }

    /// `Some(false)` when the account is unavailable here ([`Self::unavailable_reason`]),
    /// `Some(true)` when the lender or a recent probe says it works, `None` when unknown.
    pub(super) fn usable_now(&self, provider: &ProviderInstance) -> Option<bool> {
        if self.unavailable_reason(provider).is_some() {
            return Some(false);
        }
        if self.login_broker().and_then(|broker| broker.account_view(provider.kind, &provider.instance)).is_some() {
            return Some(true);
        }
        self.cached_probe(provider).map(|probe| probe.usable)
    }

    /// Whether the account works on this machine, asking the harness when nothing recent says.
    /// A probe that cannot tell (a harness without a status command, a timeout) counts as usable:
    /// the turn itself reports a sign-in problem with its own offer.
    async fn probe_usable(&self, provider: &ProviderInstance) -> bool {
        if let Some(known) = self.usable_now(provider) {
            return known;
        }
        // Tests never start a real harness to ask about a login (`set_probe_for_test` sets the answer).
        if cfg!(test) {
            return true;
        }
        let context = (|| -> Result<kybern_drivers::ProbeContext> {
            let settings = self.inner.settings.get();
            let raw = settings.providers.get(&provider.kind).cloned().unwrap_or_default();
            crate::provider_assets::prepare(&raw, provider.kind)?;
            Ok(kybern_drivers::ProbeContext {
                binary: raw.binary.clone().map(Into::into),
                cwd: Some(self.inner.settings.dir().into()),
                env: crate::provider_accounts::environment(&raw, provider.kind, &provider.instance)?,
            })
        })();
        let Ok(context) = context else {
            self.remember_probe(provider, false, None);
            return false;
        };
        let (usable, email) =
            match tokio::time::timeout(PROBE_TIMEOUT, crate::account_identity::probe_context(provider.kind, &context)).await {
                Ok((status, identity)) => (
                    !matches!(status, methods::AccountStatus::NeedsSignIn | methods::AccountStatus::SignedOut),
                    identity.and_then(|identity| identity.email),
                ),
                Err(_) => (true, None),
            };
        self.remember_probe(provider, usable, email);
        usable
    }

    fn candidates_from(&self, kind: ProviderKind, usable: &[(String, bool)], limits: BTreeMap<String, Vec<UsageLimit>>) -> Vec<Candidate> {
        usable
            .iter()
            .map(|(instance, usable)| {
                let provider = ProviderInstance { kind, instance: instance.clone() };
                Candidate {
                    instance: instance.clone(),
                    usable: *usable,
                    manual_only: self.manual_only(&provider),
                    limits: limits.get(instance).cloned().unwrap_or_default(),
                }
            })
            .collect()
    }

    /// Every account of `kind` with fresh sign-in state and limits (bounded reads).
    pub(super) async fn switch_candidates(&self, kind: ProviderKind) -> Vec<Candidate> {
        let instances = self.switch_instances(kind);
        let usable = futures::future::join_all(instances.iter().map(|instance| async move {
            let provider = ProviderInstance { kind, instance: instance.clone() };
            (instance.clone(), self.probe_usable(&provider).await)
        }))
        .await;
        let limits = self.inner.usage.candidate_limits(kind, &instances).await;
        self.candidates_from(kind, &usable, limits)
    }

    /// [`Self::switch_candidates`] from what is already known; an account nothing is known
    /// about counts as usable.
    fn cached_candidates(&self, kind: ProviderKind) -> Vec<Candidate> {
        let instances = self.switch_instances(kind);
        let usable = instances
            .iter()
            .map(|instance| (instance.clone(), self.usable_now(&ProviderInstance { kind, instance: instance.clone() }).unwrap_or(true)))
            .collect::<Vec<_>>();
        let limits = self.inner.usage.cached_limits(kind, &instances);
        self.candidates_from(kind, &usable, limits)
    }

    fn latest_failure(&self, thread_id: ThreadId) -> Result<Option<String>> {
        Ok(self.inner.store.latest_turn_quota_events(thread_id)?.iter().rev().find_map(|event| match &event.payload {
            EventPayload::TurnFailed { error, .. } => Some(error.clone()),
            _ => None,
        }))
    }

    fn suggestion_in(&self, thread: &Thread, candidates: &[Candidate], exclude: &[String]) -> Result<Option<String>> {
        let now = Utc::now().timestamp();
        let current = candidates.iter().find(|candidate| candidate.instance == thread.provider.instance);
        let window = ran_out_window(
            current.map(|candidate| candidate.limits.as_slice()).unwrap_or(&[]),
            self.latest_failure(thread.id)?.as_deref(),
            now,
        );
        Ok(pick_suggestion(&thread.provider.instance, window, candidates, now, exclude))
    }

    /// The suggestion for `ThreadTargetState`, from cached sign-ins and limits.
    pub(super) fn cached_suggestion(&self, thread: &Thread) -> Result<Option<String>> {
        self.suggestion_in(thread, &self.cached_candidates(thread.provider.kind), &[])
    }

    /// The suggestion when `unavailable` (the resolved account) is not usable here.
    pub(super) fn cached_replacement(&self, unavailable: &ProviderInstance) -> Option<String> {
        pick_suggestion(&unavailable.instance, None, &self.cached_candidates(unavailable.kind), Utc::now().timestamp(), &[])
    }

    /// `threads.target.get`: while the thread is limited, refresh the accounts' sign-ins and
    /// limits first (bounded) so the suggestion is current.
    pub async fn thread_target_fresh(&self, thread_id: ThreadId) -> Result<methods::ThreadTargetState> {
        let state = self.thread_target(thread_id)?;
        if !state.quota_limited && !state.account_unavailable {
            return Ok(state);
        }
        self.switch_candidates(state.target.provider.kind).await;
        self.thread_target(thread_id)
    }

    pub(super) fn pending_wait(&self, thread_id: ThreadId) -> Result<Option<PendingWait>> {
        self.inner
            .store
            .meta_get(&Self::wait_key(thread_id))?
            .filter(|saved| !saved.is_empty())
            .map(|saved| Ok(serde_json::from_str(&saved)?))
            .transpose()
    }

    fn take_wait(&self, thread_id: ThreadId) -> Result<Option<PendingWait>> {
        let _command = self.inner.commands.lock().map_err(|_| anyhow!("command lock poisoned"))?;
        let wait = self.pending_wait(thread_id)?;
        if wait.is_some() {
            self.inner.store.meta_set(&Self::wait_key(thread_id), "")?;
        }
        Ok(wait)
    }

    /// Stop waiting for a reset. Returns whether the thread was waiting.
    pub(super) fn cancel_account_wait(&self, thread_id: ThreadId, text: &str) -> Result<bool> {
        let Some(wait) = self.take_wait(thread_id)? else { return Ok(false) };
        if let Some(handle) = self.inner.account_switch.waits.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(&thread_id) {
            handle.abort();
        }
        self.emit(thread_id, None, EventPayload::AccountWaitEnded { account: Some(wait.account), cancelled: true, text: text.into() })?;
        Ok(true)
    }

    fn arm_wait(&self, thread_id: ThreadId, wait: PendingWait) {
        let this = self.clone();
        let handle = tokio::spawn(async move {
            let delay = (wait.until - Utc::now()).to_std().unwrap_or_default();
            tokio::time::sleep(delay).await;
            this.inner.account_switch.waits.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(&thread_id);
            if let Err(error) = this.resume_wait(thread_id).await {
                tracing::warn!(%thread_id, error = format!("{error:#}"), "could not continue a thread after its limit reset");
                let _ = this.emit(
                    thread_id,
                    None,
                    EventPayload::ProviderNotice {
                        level: NoticeLevel::Warning,
                        text: format!("Kybern couldn't continue after the limit reset: {error}. Send a message to continue."),
                        data: None,
                        problem: None,
                    },
                );
            }
        });
        if let Some(previous) =
            self.inner.account_switch.waits.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(thread_id, handle.abort_handle())
        {
            previous.abort();
        }
    }

    async fn schedule_wait(&self, thread: &Thread, account: ProviderInstance, until: DateTime<Utc>) -> Result<()> {
        let wait = PendingWait { until, account: account.clone(), message_id: Uuid::now_v7() };
        {
            let _command = self.inner.commands.lock().map_err(|_| anyhow!("command lock poisoned"))?;
            if self.pending_wait(thread.id)?.is_some() {
                return Ok(());
            }
            self.inner.store.meta_set(&Self::wait_key(thread.id), &serde_json::to_string(&wait)?)?;
        }
        let text = format!("{} is out of limit. This thread continues on it when the limit resets.", self.account_label(&account));
        self.emit(thread.id, None, EventPayload::AccountWait { until, account: Some(account), text })?;
        self.arm_wait(thread.id, wait);
        Ok(())
    }

    async fn resume_wait(&self, thread_id: ThreadId) -> Result<()> {
        let Some(wait) = self.take_wait(thread_id)? else { return Ok(()) };
        let Some(thread) = self.inner.store.thread_get(thread_id)? else { return Ok(()) };
        if thread.status == ThreadStatus::Archived || matches!(thread.status, ThreadStatus::Running | ThreadStatus::AwaitingApproval) {
            return Ok(());
        }
        let name = self.account_label(&wait.account);
        self.emit(
            thread_id,
            None,
            EventPayload::AccountWaitEnded {
                account: Some(wait.account.clone()),
                cancelled: false,
                text: format!("Limit reset. Continuing on {name}."),
            },
        )?;
        self.continue_on(
            methods::ThreadsSwitchContinueParams { thread_id, provider: Some(wait.account), message_id: wait.message_id },
            Continuation::AfterWait,
        )
        .await
        .map(|_| ())
    }

    /// Re-arm the waits saved before a restart; one whose time passed continues now.
    pub(super) fn account_waits_recover_after_restart(&self) -> Result<()> {
        for (key, saved) in self.inner.store.meta_list_prefix("account_wait:")? {
            let Some(thread_id) = key.strip_prefix("account_wait:").and_then(|id| id.parse::<ThreadId>().ok()) else { continue };
            match serde_json::from_str::<PendingWait>(&saved) {
                Ok(wait) => self.arm_wait(thread_id, wait),
                Err(error) => tracing::warn!(%thread_id, %error, "dropping an unreadable account wait"),
            }
        }
        Ok(())
    }

    /// After a turn settles: a turn a limit stopped waits for its own account's reset (when
    /// known) and continues on it. Another account is only ever offered (`suggested_account`).
    pub(super) fn after_settled_turn(&self, thread_id: ThreadId) {
        let this = self.clone();
        tokio::spawn(async move {
            if let Err(error) = this.recover_limited_turn(thread_id).await {
                tracing::warn!(%thread_id, error = format!("{error:#}"), "could not schedule a wait for the account's limit to reset");
            }
        });
    }

    pub(super) async fn recover_limited_turn(&self, thread_id: ThreadId) -> Result<()> {
        let Some(thread) = self.inner.store.thread_get(thread_id)? else { return Ok(()) };
        if thread.subagent.is_some() || thread.inbound.is_some() || thread.moved.is_some() || thread.status == ThreadStatus::Archived {
            return Ok(());
        }
        if !self.thread_quota_limited(&thread)? || self.pending_wait(thread_id)?.is_some() {
            return Ok(());
        }
        if !self.inner.account_switch.deciding.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(thread_id) {
            return Ok(());
        }
        let result = async {
            // One bounded read for the whole harness, so the offer's suggestion is current too.
            let candidates = self.switch_candidates(thread.provider.kind).await;
            let own = candidates.iter().find(|candidate| candidate.instance == thread.provider.instance);
            if let Some(ready) = own.and_then(|own| own_reset(&own.limits, Utc::now().timestamp()))
                && let Some(until) = DateTime::from_timestamp(ready, 0)
            {
                self.schedule_wait(&thread, thread.provider.clone(), until).await?;
            }
            Ok(())
        }
        .await;
        self.inner.account_switch.deciding.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(&thread_id);
        result
    }

    /// For a limited thread whose own reset is known: the line saying it waits for it.
    pub(super) fn limit_wait_note(&self, thread: &Thread) -> Result<Option<String>> {
        if !self.thread_quota_limited(thread)? {
            return Ok(None);
        }
        let until = match self.pending_wait(thread.id)? {
            Some(wait) => Some(wait.until),
            None => {
                let limits = self.inner.usage.cached_limits(thread.provider.kind, std::slice::from_ref(&thread.provider.instance));
                own_reset(limits.get(&thread.provider.instance).map(Vec::as_slice).unwrap_or(&[]), Utc::now().timestamp())
                    .and_then(|ready| DateTime::from_timestamp(ready, 0))
            }
        };
        Ok(until.map(|until| {
            format!(
                "{} is out of limit. This agent waits for its reset ({} UTC) and continues on the same account; its result follows when it finishes.",
                self.account_label(&thread.provider),
                until.format("%Y-%m-%d %H:%M")
            )
        }))
    }

    /// The account a send would use, as `thread_target` resolves it, without requiring it to exist here.
    pub(super) fn resolved_provider(&self, thread: &Thread) -> Result<ProviderInstance> {
        let mut provider = self.stored_target(thread)?.map(|target| target.provider).unwrap_or_else(|| thread.provider.clone());
        let settings = self.inner.settings.get();
        let raw = settings.providers.get(&provider.kind).cloned().unwrap_or_default();
        let project = self.inner.store.project_get(thread.project_id)?.ok_or_else(|| anyhow!("Project not found."))?;
        let override_id = self.inner.store.meta_get(&format!("account_override:{}", thread.id))?.filter(|s| !s.is_empty());
        let chosen = override_id.or_else(|| Self::account_it_ran_on(thread, &provider, &raw));
        provider.instance = crate::provider_accounts::resolve(&raw, Some(&project.path), chosen.as_deref());
        Ok(provider)
    }

    /// A send whose account is not usable on this machine fails before anything starts, saying
    /// which account the person can use here instead. Kybern never picks it for them.
    pub(super) fn ensure_account_available(&self, thread_id: ThreadId) -> Result<()> {
        let Some(thread) = self.inner.store.thread_get(thread_id)? else { return Ok(()) };
        if thread.subagent.is_some() || thread.inbound.is_some() || thread.moved.is_some() {
            return Ok(());
        }
        let provider = self.resolved_provider(&thread)?;
        let Some(reason) = self.unavailable_reason(&provider) else { return Ok(()) };
        match self.cached_replacement(&provider) {
            Some(instance) => anyhow::bail!(
                "{reason} Use {} here instead, or sign this account in on this machine.",
                self.account_label(&ProviderInstance { kind: provider.kind, instance })
            ),
            None => anyhow::bail!("{reason} Sign it in on this machine, or choose another account."),
        }
    }

    /// The person picked another account for a thread whose account is not usable here: record it.
    pub(super) fn record_unavailable_switch(&self, thread_id: ThreadId, from: &ProviderInstance, to: &ProviderInstance) -> Result<()> {
        if from.kind != to.kind || from == to || self.unavailable_reason(from).is_none() {
            return Ok(());
        }
        let text = format!("Using {} on this machine, where {} isn't available.", self.account_label(to), self.account_label(from));
        self.emit(
            thread_id,
            None,
            EventPayload::AccountSwitched { from: from.clone(), to: to.clone(), reason: AccountSwitchReason::Unavailable, text },
        )?;
        Ok(())
    }

    /// `threads.switch_continue` (the person's tap) and the end of a wait: continue on
    /// `params.provider` (or the suggestion) and send the continuation once. Retrying with the
    /// same message id never sends a second prompt. After a wait the account is the thread's own.
    pub(super) async fn continue_on(
        &self,
        params: methods::ThreadsSwitchContinueParams,
        how: Continuation,
    ) -> Result<methods::ThreadsSendResult> {
        self.ensure_not_subagent(params.thread_id)?;
        let operation_key = format!("quota_continue:{}", params.message_id);
        let previous = self
            .inner
            .store
            .meta_get(&operation_key)?
            .filter(|saved| !saved.is_empty())
            .map(|saved| serde_json::from_str::<methods::ThreadsSwitchContinueParams>(&saved))
            .transpose()?;
        if let Some(previous) = &previous {
            ensure!(
                previous.thread_id == params.thread_id && (params.provider.is_none() || params.provider == previous.provider),
                "Continuation id belongs to a different account or request."
            );
            if let Some((owner, turn_id, _)) = self.inner.store.turn_started_receipt(params.message_id)? {
                ensure!(owner == params.thread_id, "Continuation id belongs to another thread.");
                return Ok(methods::ThreadsSendResult { turn_id, message_id: params.message_id, queued: false });
            }
        } else {
            ensure!(
                self.inner.store.turn_started_receipt(params.message_id)?.is_none(),
                "Continuation id already belongs to another message."
            );
        }
        let thread = self.inner.store.thread_get(params.thread_id)?.ok_or_else(|| anyhow!("Thread not found."))?;
        ensure!(thread.status != ThreadStatus::Archived, "Unarchive this conversation before continuing.");
        if how != Continuation::AfterWait {
            ensure!(
                self.thread_quota_limited(&thread)?,
                "The latest turn was not interrupted by a confirmed 5-hour or weekly account limit. Retry your prompt normally."
            );
        }
        let provider = match previous.and_then(|previous| previous.provider).or(params.provider.clone()) {
            Some(provider) => provider,
            None => {
                let candidates = self.switch_candidates(thread.provider.kind).await;
                let instance = self
                    .suggestion_in(&thread, &candidates, &[])?
                    .ok_or_else(|| anyhow!("No other account has limit left. Add an account, or wait for the limit to reset."))?;
                ProviderInstance { kind: thread.provider.kind, instance }
            }
        };
        let switching = provider != thread.provider;
        if how == Continuation::AfterWait {
            ensure!(!switching, "A wait continues on the thread's own account.");
        } else {
            ensure!(provider.kind == thread.provider.kind && switching, "Choose a different account for the same agent.");
        }
        let signature =
            serde_json::to_string(&methods::ThreadsSwitchContinueParams { provider: Some(provider.clone()), ..params.clone() })?;
        if switching {
            self.validate_provider_selection(thread.project_id, &provider, thread.model.as_deref(), thread.effort.as_deref()).await?;
        }
        {
            let _command = self.inner.commands.lock().map_err(|_| anyhow!("command lock poisoned"))?;
            if let Some(saved) = self.inner.store.meta_get(&operation_key)?.filter(|saved| !saved.is_empty()) {
                ensure!(saved == signature, "Continuation id belongs to a different account or request.");
            }
            self.inner.store.meta_set(&operation_key, &signature)?;
        }
        if matches!(thread.status, ThreadStatus::Running | ThreadStatus::AwaitingApproval) {
            self.interrupt_turn(thread.id, "continuing on another account after a usage limit").await?;
            for _ in 0..100 {
                if self
                    .inner
                    .store
                    .thread_get(thread.id)?
                    .is_some_and(|thread| !matches!(thread.status, ThreadStatus::Running | ThreadStatus::AwaitingApproval))
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            ensure!(
                self.inner
                    .store
                    .thread_get(thread.id)?
                    .is_some_and(|thread| !matches!(thread.status, ThreadStatus::Running | ThreadStatus::AwaitingApproval)),
                "The agent is still stopping. Try Switch and continue after it stops."
            );
        }
        // The continuation is this thread's next step: a wait for a reset no longer applies.
        if how != Continuation::AfterWait {
            self.cancel_account_wait(thread.id, "Stopped waiting: the thread continues on another account.")?;
        }
        let previous_target = self.thread_target(thread.id)?;
        let mut target = previous_target.target.clone();
        target.provider = provider.clone();
        if switching {
            self.set_thread_target(methods::ThreadTargetParams { thread_id: thread.id, target: target.clone(), inherit_account: false })
                .await?;
            let text =
                format!("{} is out of limit. Continuing on {}.", self.account_label(&thread.provider), self.account_label(&provider));
            self.emit(
                thread.id,
                None,
                EventPayload::AccountSwitched {
                    from: thread.provider.clone(),
                    to: provider.clone(),
                    reason: AccountSwitchReason::Limit,
                    text,
                },
            )?;
        }
        self.inner.store.meta_set(&format!("quota_target:{}", params.message_id), &serde_json::to_string(&target)?)?;
        let message = UserMessage::text(
            "Continue the interrupted task from the saved conversation. Honor the user's existing instructions, inspect completed work before acting, and do not repeat completed mutations.",
        );
        let result = self
            .send_client_message(methods::ThreadsSendParams { thread_id: thread.id, message, message_id: Some(params.message_id) })
            .await;
        if switching
            && result.is_err()
            && self.inner.store.turn_started_receipt(params.message_id)?.is_none()
            && self.thread_target(thread.id)?.target == target
        {
            self.set_thread_target(methods::ThreadTargetParams {
                thread_id: thread.id,
                target: previous_target.target,
                inherit_account: !previous_target.account_override,
            })
            .await?;
        }
        result
    }
}

/// Harnesses whose accounts a delegated agent can be pinned to.
const DELEGATION_KINDS: [ProviderKind; 4] =
    [ProviderKind::ClaudeCode, ProviderKind::Codex, ProviderKind::Cursor, ProviderKind::Antigravity];
/// Longest a delegation waits for sign-in probes or another machine's account list.
const DELEGATION_LOOKUP: Duration = Duration::from_secs(5);

impl Orchestrator {
    fn machine_label(&self) -> String {
        self.remote_hub().map(|hub| hub.self_name()).unwrap_or_else(|| "this machine".into())
    }

    fn delegation_account(&self, provider: &ProviderInstance) -> methods::DelegationAccount {
        let settings = self.inner.settings.get();
        let raw = settings.providers.get(&provider.kind).cloned().unwrap_or_default();
        methods::DelegationAccount {
            provider: provider.kind,
            instance: provider.instance.clone(),
            name: self.account_label(provider),
            key: self.account_email(provider).map(|email| AccountsShared::key(provider.kind, &email)),
            is_default: crate::provider_accounts::resolve(&raw, None, None) == provider.instance,
        }
    }

    /// The signed-in accounts of each harness on this machine, for `kybern_agent_capabilities`
    /// and `peer.accounts.list`. Never limits: the parent picks the account the user named.
    /// Accounts whose sign-in could not be checked in time are listed.
    pub(super) async fn delegation_accounts(&self) -> Vec<methods::DelegationAccount> {
        let providers = DELEGATION_KINDS
            .into_iter()
            .filter(|kind| self.inner.drivers.get(*kind).is_some())
            .flat_map(|kind| self.switch_instances(kind).into_iter().map(move |instance| ProviderInstance { kind, instance }))
            .collect::<Vec<_>>();
        let checks = providers
            .iter()
            .map(|provider| async move { tokio::time::timeout(DELEGATION_LOOKUP, self.probe_usable(provider)).await.unwrap_or(true) });
        let usable = futures::future::join_all(checks).await;
        providers.iter().zip(usable).filter(|(_, usable)| *usable).map(|(provider, _)| self.delegation_account(provider)).collect()
    }

    pub(super) fn account_matches(account: &methods::DelegationAccount, query: &str) -> bool {
        let query = query.trim().to_lowercase();
        account.instance.to_lowercase() == query
            || account.name.trim().to_lowercase() == query
            || account.key.as_deref().is_some_and(|key| key == query || key.split_once(':').is_some_and(|(_, email)| email == query))
            || (account.instance == "default" && matches!(query.as_str(), "default" | "terminal login" | "cli account"))
    }

    /// The other machines where an account matching `query` is signed in, by name (bounded).
    pub(super) async fn machines_with_account(&self, kind: ProviderKind, query: &str) -> Vec<String> {
        let Some(hub) = self.remote_hub().cloned() else { return Vec::new() };
        let asks = hub.targets().into_iter().filter(|target| target.online).map(|target| {
            let hub = hub.clone();
            async move {
                let answer = tokio::time::timeout(
                    DELEGATION_LOOKUP,
                    hub.call(&target.id, <methods::PeerAccountsList as methods::Method>::NAME, json!({})),
                )
                .await;
                let accounts = answer.ok()?.ok().and_then(|value| serde_json::from_value::<methods::PeerAccountsListResult>(value).ok())?;
                accounts
                    .accounts
                    .iter()
                    .any(|account| account.provider == kind && Self::account_matches(account, query))
                    .then_some(target.name)
            }
        });
        futures::future::join_all(asks).await.into_iter().flatten().collect()
    }

    /// The account a delegated agent of `kind` runs on, from the parent's `account` (a name, a
    /// `<kind>:<email>` key, an email or an instance id). It must be signed in on this machine.
    pub(super) async fn resolve_delegation_account(&self, kind: ProviderKind, query: &str) -> Result<ProviderInstance, String> {
        let machine = self.machine_label();
        let accounts = self
            .switch_instances(kind)
            .into_iter()
            .map(|instance| self.delegation_account(&ProviderInstance { kind, instance }))
            .collect::<Vec<_>>();
        let Some(account) = accounts.iter().find(|account| Self::account_matches(account, query)) else {
            let here = accounts.iter().map(|account| account.name.clone()).collect::<Vec<_>>().join(", ");
            return Err(format!("{} has no account \"{}\" on {machine}. Accounts here: {here}.", kind.display_name(), query.trim()));
        };
        let provider = ProviderInstance { kind, instance: account.instance.clone() };
        if let Some(reason) = self.unavailable_reason(&provider) {
            return Err(reason);
        }
        if !self.probe_usable(&provider).await {
            return Err(format!("{} is not signed in on {machine}.", account.name));
        }
        Ok(provider)
    }

    /// The error for an account the parent asked for that is not usable where the agent would run,
    /// naming the machines where it is signed in.
    pub(super) async fn delegation_account_error(&self, kind: ProviderKind, query: &str, reason: String) -> anyhow::Error {
        let elsewhere = self.machines_with_account(kind, query).await;
        if elsewhere.is_empty() {
            anyhow!("{reason} Use an account the user named or omit account for the default.")
        } else {
            anyhow!("{reason} It is signed in on {}: pass machine to run the agent there.", elsewhere.join(", "))
        }
    }

    /// Pin a new delegated thread to the account its parent chose (`threads.target.set` semantics).
    pub(super) fn pin_account(&self, thread_id: ThreadId, provider: &ProviderInstance) -> Result<()> {
        self.inner.store.meta_set(&format!("account_override:{thread_id}"), &provider.instance)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limit(window: u64, used: f64, resets_at: Option<i64>) -> UsageLimit {
        UsageLimit { name: format!("{window}"), used_percent: used, window_minutes: Some(window), resets_at }
    }

    fn candidate(instance: &str, limits: Vec<UsageLimit>) -> Candidate {
        Candidate { instance: instance.into(), usable: true, manual_only: false, limits }
    }

    #[test]
    fn the_suggestion_has_the_most_room_in_the_window_that_ran_out() {
        let now = 1_000_000;
        let soon = Some(now + 3600);
        let candidates = vec![
            candidate("default", vec![limit(FIVE_HOURS, 100.0, soon), limit(WEEK, 40.0, None)]),
            candidate("a", vec![limit(FIVE_HOURS, 60.0, soon), limit(WEEK, 10.0, None)]),
            candidate("b", vec![limit(FIVE_HOURS, 20.0, soon), limit(WEEK, 70.0, None)]),
            candidate("unknown", vec![]),
        ];
        assert_eq!(pick_suggestion("default", Some(FIVE_HOURS), &candidates, now, &[]).as_deref(), Some("b"));
        // The weekly window ran out: room there counts.
        assert_eq!(pick_suggestion("default", Some(WEEK), &candidates, now, &[]).as_deref(), Some("a"));
        // An account never read comes after every one with known room, but before nothing.
        assert_eq!(pick_suggestion("default", Some(FIVE_HOURS), &candidates, now, &["a".into(), "b".into()]).as_deref(), Some("unknown"));
        assert_eq!(ran_out_window(&candidates[0].limits, None, now), Some(FIVE_HOURS));
        assert_eq!(ran_out_window(&[], Some("You've hit your weekly limit"), now), Some(WEEK));
    }

    #[test]
    fn manual_only_unusable_full_and_nearly_weekly_out_accounts_are_skipped() {
        let now = 1_000_000;
        let mut manual = candidate("manual", vec![limit(FIVE_HOURS, 0.0, None)]);
        manual.manual_only = true;
        let mut away = candidate("away", vec![limit(FIVE_HOURS, 0.0, None)]);
        away.usable = false;
        let candidates = vec![
            candidate("default", vec![limit(FIVE_HOURS, 100.0, Some(now + 60))]),
            manual,
            away,
            candidate("weekly", vec![limit(FIVE_HOURS, 0.0, None), limit(WEEK, 92.0, Some(now + 86_400))]),
            candidate("full", vec![limit(FIVE_HOURS, 100.0, Some(now + 60))]),
        ];
        assert_eq!(pick_suggestion("default", Some(FIVE_HOURS), &candidates, now, &[]), None);
        // A weekly window that already reset no longer counts against the account.
        let reset = vec![candidate("default", vec![]), candidate("weekly", vec![limit(WEEK, 95.0, Some(now - 1))])];
        assert_eq!(pick_suggestion("default", None, &reset, now, &[]).as_deref(), Some("weekly"));
    }

    #[test]
    fn the_wait_is_for_the_last_reset_among_full_windows_of_the_own_account() {
        let now = 1_000_000;
        let both = vec![limit(FIVE_HOURS, 100.0, Some(now + 7200)), limit(WEEK, 100.0, Some(now + 90_000))];
        assert_eq!(own_reset(&both, now), Some(now + 90_000 + WAIT_MARGIN_SECONDS));
        assert_eq!(
            own_reset(&[limit(FIVE_HOURS, 100.0, Some(now + 60)), limit(WEEK, 50.0, None)], now),
            Some(now + 60 + WAIT_MARGIN_SECONDS)
        );
        // A full window without a reset time, or nothing full: no wait.
        assert_eq!(own_reset(&[limit(FIVE_HOURS, 100.0, None)], now), None);
        assert_eq!(own_reset(&[limit(FIVE_HOURS, 40.0, Some(now + 60))], now), None);
    }
}
