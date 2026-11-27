//! Sessions that run on a login another machine lent (ADE-86 S4, design §9.4).
//!
//! Three small hooks around the login broker (`network/broker.rs`):
//!
//! * [`Orchestrator::borrowed_login`]: when a session starts for an account bound to the broker, borrow the
//!   login and give the driver a handle to it. Claude and Codex resolve the handle themselves; omp gets the
//!   URL and token of the broker's `omp auth-broker serve`.
//! * [`Orchestrator::login_rotated`]: the broker pushed a new token, so a Claude process that is idle ends
//!   (stdin closed, never killed) and the next message resumes it with the new token.
//! * [`Orchestrator::plan_login_recovery`]: a turn failed because the lent token no longer works. End the
//!   process the same way, borrow again, resume, and send the message once more: one resume per rotation.

use super::*;
use kybern_drivers::login_lend::{self, BORROW_ENV};

impl Orchestrator {
    pub fn with_login_broker(mut self, broker: Arc<crate::network::broker::LoginBroker>) -> Self {
        Arc::get_mut(&mut self.inner).expect("the login broker must be installed before cloning the orchestrator").remote.login =
            Some(broker);
        self
    }

    pub fn login_broker(&self) -> Option<&Arc<crate::network::broker::LoginBroker>> {
        self.inner.remote.login.as_ref()
    }

    /// Part of a live session's identity: a session started before the account was bound (or after it was
    /// unbound) must not be reused.
    pub(super) fn login_binding_tag(&self, thread: &Thread) -> Option<String> {
        self.login_broker()?.binding(thread.provider.kind, &thread.provider.instance)
    }

    /// Borrow the login for a session of a bound account. Returns the handle to unregister once the driver
    /// has spawned. The error is the sentence to show ("Claude Code signs in through VPS, which is offline ·
    /// Sign in here instead").
    pub(super) async fn borrowed_login(
        &self,
        thread: &Thread,
        env: &mut std::collections::BTreeMap<String, String>,
    ) -> Result<Option<String>> {
        let Some(broker) = self.login_broker() else { return Ok(None) };
        let (kind, instance) = (thread.provider.kind, thread.provider.instance.as_str());
        let Some(account) = broker.binding(kind, instance) else { return Ok(None) };
        // The refusal keeps its `login_borrow` problem, so the failed turn offers "Sign in on <machine> instead".
        let source = broker.acquire_or_problem(kind, instance, &account).await.map_err(anyhow::Error::new)?;
        if kind == ProviderKind::Omp {
            let login = source.current().await.map_err(|text| anyhow!(text))?;
            for (key, value) in login_lend::omp_env(&login).unwrap_or_default() {
                env.insert(key.into(), value);
            }
            return Ok(None);
        }
        let handle = login_lend::register(source);
        env.insert(BORROW_ENV.into(), handle.clone());
        if kind == ProviderKind::ClaudeCode && std::env::var(login_lend::CLAUDE_HOTSWAP_ENV).is_ok_and(|value| value == "1") {
            env.insert(login_lend::CLAUDE_HOTSWAP_ENV.into(), "1".into());
        }
        Ok(Some(handle))
    }

    /// The broker pushed a new Claude token for a local account. Idle sessions of the account end gracefully
    /// and resume on their next message; a running turn is left alone (it recovers if it is rejected).
    pub async fn login_rotated(&self, kind: ProviderKind, instance: &str) {
        if kind != ProviderKind::ClaudeCode {
            return;
        }
        self.end_login_sessions(kind, instance, true).await;
    }

    /// Stop the live sessions of a local account whose borrowed login is gone (the loan was released, the
    /// broker moved, the lender left): a Codex app-server or a Claude process keeps the lent token in memory
    /// for as long as it runs. The next message starts a session without the loan, which finds the account
    /// signed out. With `idle_only`, a session with a turn, a task or queued input in flight is left to finish.
    pub async fn end_login_sessions(&self, kind: ProviderKind, instance: &str, idle_only: bool) {
        let candidates: Vec<(ThreadId, Arc<LiveSession>)> =
            self.inner.sessions.lock().await.iter().map(|(id, live)| (*id, live.clone())).collect();
        for (thread_id, live) in candidates {
            let Ok(Some(thread)) = self.inner.store.thread_get(thread_id) else { continue };
            if thread.provider.kind != kind || thread.provider.instance != instance {
                continue;
            }
            if idle_only
                && (live.turn.lock().await.is_some()
                    || live.tasks.lock().await.values().any(|task| task.status.is_active())
                    || !live.pending.lock().await.is_empty()
                    || thread.status == ThreadStatus::Running)
            {
                continue;
            }
            {
                let mut sessions = self.inner.sessions.lock().await;
                if !sessions.get(&thread_id).is_some_and(|current| Arc::ptr_eq(current, &live)) {
                    continue;
                }
                sessions.remove(&thread_id);
            }
            live.mark_released();
            self.revoke_native_session(&live);
            if let Err(error) = live.session.close().await {
                tracing::debug!(%error, %thread_id, "closing a session after its login ended failed");
            }
            let _ = self.emit(thread_id, None, EventPayload::ProviderSessionReleased { reason: SessionReleaseReason::Manual });
        }
    }

    /// A turn failed. If the lent login was rejected, plan to recover once: end the process gracefully, borrow
    /// a fresh token, resume the provider conversation and send the same message again. Call while holding
    /// `live.turn`, then [`Orchestrator::run_resend`] once it is released. `None`: the failure is the turn's.
    pub(super) fn plan_login_recovery(
        &self,
        thread_id: ThreadId,
        live: &Arc<LiveSession>,
        turn_id: TurnId,
        error: &str,
    ) -> Option<resend::PlannedResend> {
        let broker = self.login_broker().cloned()?;
        let thread = self.inner.store.thread_get(thread_id).ok().flatten()?;
        let (kind, instance) = (thread.provider.kind, thread.provider.instance.clone());
        let account = broker.binding(kind, &instance)?;
        if !login_lend::is_login_failure(kind, error) || live.is_released() || !broker.take_recovery(turn_id) {
            return None;
        }
        let (message_id, mut message) = self.inner.store.turn_started_message(thread_id, turn_id).ok().flatten()?;
        // The stored prompt holds large images as references (#298); the agent gets them inline again.
        self.resolve_attachments(&mut message);
        tracing::info!(%thread_id, provider = kind.as_str(), "the lent login was rejected; borrowing again and resuming");
        let guard = self.begin_resend(thread_id, turn_id, resend::ResendReason::RejectedLogin);
        let renew: resend::LoginRenewal = Box::pin(async move { broker.renew(kind, &instance, &account).await });
        Some(resend::PlannedResend { guard, message_id, message, login: Some((kind, renew)) })
    }
}
