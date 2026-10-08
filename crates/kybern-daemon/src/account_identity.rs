//! Who is signed in to each account, cached for five minutes.
//!
//! The cache is keyed by the account's environment digest, so editing an
//! account's folder or the provider environment invalidates it. When a probe
//! learns a new email or plan for a named account, it writes them back to the
//! account for instant rendering. Credentials are never stored.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use kybern_protocol::methods::{AccountIdentity, AccountStatus};
use kybern_protocol::{ProviderInstance, ProviderKind};
use sha2::{Digest, Sha256};

use crate::state::AppState;

const FRESH: Duration = Duration::from_secs(5 * 60);

type Key = (ProviderKind, String);
type Probed = (AccountStatus, Option<AccountIdentity>);

#[derive(Default)]
pub struct AccountIdentities {
    cache: Mutex<HashMap<Key, Cached>>,
}

struct Cached {
    digest: String,
    at: Instant,
    probed: Probed,
}

impl AccountIdentities {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<Key, Cached>> {
        self.cache.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn invalidate(&self, instance: &ProviderInstance) {
        self.lock().remove(&(instance.kind, instance.instance.clone()));
    }

    /// Record a result learned elsewhere (a finished sign-in, a sign-out).
    pub fn remember(&self, instance: &ProviderInstance, digest: String, probed: Probed) {
        self.lock().insert((instance.kind, instance.instance.clone()), Cached { digest, at: Instant::now(), probed });
    }

    /// The last known result without probing, whatever its age.
    #[cfg(test)]
    pub fn peek(&self, instance: &ProviderInstance) -> Option<Probed> {
        self.lock().get(&(instance.kind, instance.instance.clone())).map(|cached| cached.probed.clone())
    }

    /// Probe an account (or answer from the cache), then write a changed
    /// email or plan back to the stored account.
    pub async fn probe(&self, state: &AppState, instance: &ProviderInstance, refresh: bool) -> Probed {
        let Ok(context) = crate::provider_accounts::context(state, instance) else {
            return (AccountStatus::Unknown, None);
        };
        let digest = digest(&context.env);
        if !refresh
            && let Some(cached) = self.lock().get(&(instance.kind, instance.instance.clone()))
            && cached.digest == digest
            && cached.at.elapsed() < FRESH
        {
            return cached.probed.clone();
        }
        let probed = probe_context(instance.kind, &context).await;
        self.remember(instance, digest, probed.clone());
        write_back(state, instance, &probed.1);
        probed
    }
}

/// Probe with a ready context. Cursor needs its SDK installed first.
pub async fn probe_context(kind: ProviderKind, context: &kybern_drivers::ProbeContext) -> Probed {
    let mut context = context.clone();
    if kind == ProviderKind::Cursor {
        // The provider binary setting is reserved for old ACP sessions.
        context.binary = None;
        if !kybern_drivers::cursor::installed(&context) {
            return (AccountStatus::Unknown, None);
        }
    }
    kybern_drivers::account_auth::identity(kind, &context).await
}

pub fn digest(env: &std::collections::BTreeMap<String, String>) -> String {
    let bytes = Sha256::digest(serde_json::to_vec(env).unwrap_or_default());
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn write_back(state: &AppState, instance: &ProviderInstance, identity: &Option<AccountIdentity>) {
    let Some(identity) = identity else { return };
    if instance.instance == "default" || (identity.email.is_none() && identity.plan.is_none()) {
        return;
    }
    let mut settings = state.settings.get();
    let Some(account) = settings.providers.get_mut(&instance.kind).and_then(|provider| provider.accounts.get_mut(&instance.instance)) else {
        return;
    };
    let email = identity.email.clone().or_else(|| account.email.clone());
    let plan = identity.plan.clone().or_else(|| account.plan.clone());
    if account.email == email && account.plan == plan {
        return;
    }
    account.email = email;
    account.plan = plan;
    if let Err(error) = state.settings.set(settings) {
        tracing::debug!(%error, "could not save an account's identity");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digest_changes_with_the_environment() {
        let mut env = std::collections::BTreeMap::new();
        let empty = digest(&env);
        env.insert("CLAUDE_CONFIG_DIR".into(), "/a".into());
        let a = digest(&env);
        env.insert("CLAUDE_CONFIG_DIR".into(), "/b".into());
        assert_ne!(empty, a);
        assert_ne!(a, digest(&env));
    }

    #[test]
    fn remembered_results_can_be_peeked_and_invalidated() {
        let identities = AccountIdentities::default();
        let instance = ProviderInstance { kind: ProviderKind::Codex, instance: "work".into() };
        assert!(identities.peek(&instance).is_none());
        identities.remember(&instance, "d".into(), (AccountStatus::SignedOut, None));
        assert_eq!(identities.peek(&instance).unwrap().0, AccountStatus::SignedOut);
        identities.invalidate(&instance);
        assert!(identities.peek(&instance).is_none());
    }
}
