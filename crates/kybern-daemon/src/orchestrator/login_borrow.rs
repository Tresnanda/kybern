//! Sessions that run on a login another machine lent (ADE-86 S4, design §9.4).
//!
//! Three small hooks around the login broker (`network/broker.rs`):
//!
//! * [`Orchestrator::borrowed_login`]: when a session starts for an account bound to the broker, borrow the
//!   login and give the driver a handle to it. Claude and Codex resolve the handle themselves; omp gets the
//!   URL and token of the broker's `omp auth-broker serve`.
//! * [`Orchestrator::login_rotated`]: the broker pushed a new token, so a Claude process that is idle ends
//!   (stdin closed, never killed) and the next message resumes it with the new token.
//! * [`Orchestrator::recover_rejected_login`]: a turn failed because the lent token no longer works. End the
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
        let source = broker.acquire(kind, instance, &account).await.map_err(|text| anyhow!(text))?;
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

    /// `start_turn` behind a boxed future. A session's event pump reaches `recover_rejected_login`, which
    /// restarts the turn, which spawns a session with a pump: erasing the type here ends that cycle.
    fn start_turn_erased(
        &self,
        thread: Thread,
        turn_id: TurnId,
        message_id: MessageId,
        message: UserMessage,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + '_>> {
        Box::pin(self.start_turn(thread, turn_id, message_id, message, std::time::Instant::now()))
    }

    /// A turn failed. If the lent login was rejected, recover once: end the process gracefully, borrow a
    /// fresh token, resume the provider conversation and send the same message again. Returns whether the
    /// failure was taken over (the turn then neither fails nor completes here).
    pub(super) async fn recover_rejected_login(&self, thread_id: ThreadId, live: &Arc<LiveSession>, turn_id: TurnId, error: &str) -> bool {
        let Some(broker) = self.login_broker().cloned() else { return false };
        let Ok(Some(thread)) = self.inner.store.thread_get(thread_id) else { return false };
        let (kind, instance) = (thread.provider.kind, thread.provider.instance.clone());
        let Some(account) = broker.binding(kind, &instance) else { return false };
        if !login_lend::is_login_failure(kind, error) || live.is_released() || !broker.take_recovery(turn_id) {
            return false;
        }
        let Ok(Some((message_id, message))) = self.inner.store.turn_started_message(thread_id, turn_id) else { return false };
        {
            let mut sessions = self.inner.sessions.lock().await;
            if sessions.get(&thread_id).is_some_and(|current| Arc::ptr_eq(current, live)) {
                sessions.remove(&thread_id);
            }
        }
        live.mark_released();
        self.revoke_native_session(live);
        tracing::info!(%thread_id, provider = kind.as_str(), "the lent login was rejected; borrowing again and resuming");
        let (this, live) = (self.clone(), live.clone());
        tokio::spawn(async move {
            // Stdin is closed and the process left to finish: killing Claude mid-refresh loses its tokens.
            if let Err(error) = live.session.close().await {
                tracing::debug!(%error, %thread_id, "closing a session whose login was rejected failed");
            }
            let renewed = broker.renew(kind, &instance, &account).await;
            let restarted = match renewed {
                Ok(()) => match this.inner.store.thread_get(thread_id) {
                    Ok(Some(thread)) => {
                        this.start_turn_erased(thread, turn_id, message_id, message).await.map_err(|error| error.to_string())
                    }
                    _ => Err("The thread no longer exists.".to_string()),
                },
                Err(text) => Err(text),
            };
            if let Err(text) = restarted {
                // start_turn reports its own failures; a failed borrow is reported here.
                let already =
                    this.inner.store.thread_get(thread_id).ok().flatten().is_some_and(|thread| thread.status == ThreadStatus::Failed);
                if !already {
                    let _ = this.emit(thread_id, Some(turn_id), EventPayload::TurnFailed { error: text.clone() });
                    if let Ok(Some(mut thread)) = this.inner.store.thread_get(thread_id) {
                        thread.status = ThreadStatus::Failed;
                        let _ = this.update_thread(thread);
                    }
                    this.delegation_turn_finished(thread_id, turn_id, delegation::TurnOutcome::Failed(text));
                }
            }
        });
        true
    }
}
