//! Accounts across machines on the wire: `Settings.accounts_shared` and what each machine holds, as signed
//! field registers exchanged on every pass like the preference files (`preferences.rs`, `peer.preferences.sync`).
//!
//! * **Registers.** One per entity, last writer wins by `(lamport, signer, id)`: `profile:<key>`,
//!   `default:<kind>`, `project:<kind>:<repo>`, `offer:<id>` (a `null` value is a removal),
//!   and `holdings:<machine>`, which only that machine may sign: its accounts with their keys and states and
//!   its defaults from before the migration. Holdings are what lets any daemon compute offers for the whole
//!   network without asking each machine (`accounts_offers`).
//! * **Local edits.** A change to `accounts_shared` on this machine, by any route, is found by comparing the
//!   settings with the values last synchronized (the baseline) and sealed then. The first sealing on a
//!   machine (its migration) uses clock zero, so an import never overrides an edit made since on another
//!   machine; two imports that differ are settled by signer and listed as a clash.
//! * **Applying.** What the registers hold is written back to `accounts_shared`; `accounts_shared::normalize`
//!   then maps it onto this machine's own accounts.

use std::collections::BTreeMap;
use std::sync::Arc;

use base64::{Engine, engine::general_purpose::STANDARD as B64};
use kybern_protocol::methods::{AccountStatus, AccountSummary, PeerAccountsSync};
use kybern_protocol::{
    AccountProfile, AccountsShared, MachineId, OfferDismissal, OpEnvelope, PeerSpacesSyncParams, PeerSpacesSyncResult, ProviderKind,
    RpcError, SpaceField, features,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{keys, ops, peers::PeerLink, spaces};
use crate::state::AppState;

const KEY: &str = "network.accounts.v1";
const BASE: &str = "network.accounts.base.v1";
const SELF_HOLDINGS: &str = "accounts.holdings.self";
const FIELD: &str = "account";
/// Registers kept, every kind together.
const MAX_REGISTERS: usize = 2048;
const MAX_BODY: usize = 65536;
const MAX_HOLDINGS: usize = 128;

type Registers = BTreeMap<String, OpEnvelope>;

/// One account on one machine, as the other machines see it. Never a credential.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Holding {
    pub kind: ProviderKind,
    /// This machine's instance id (`default` is the terminal login).
    pub instance: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(default)]
    pub terminal: bool,
    pub status: AccountStatus,
    /// The machine whose sign-in this account borrows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub borrowed_from: Option<MachineId>,
}

impl Holding {
    /// Signed in here, on its own or through a lender that answers.
    pub fn usable(&self) -> bool {
        self.status == AccountStatus::SignedIn
    }
}

/// What one machine has.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MachineHoldings {
    #[serde(default)]
    pub accounts: Vec<Holding>,
    /// Its default of each harness from before the migration.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub premigration: BTreeMap<ProviderKind, String>,
    /// The harnesses installed there. `None` from a daemon that doesn't say.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installed: Option<Vec<ProviderKind>>,
    /// The harnesses it has threads for. `None` from a daemon that doesn't say.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub threads: Option<Vec<ProviderKind>>,
}

impl MachineHoldings {
    /// Whether the harness is installed there. A daemon that doesn't say listed a terminal login only for
    /// a harness whose status it could read.
    pub fn has_installed(&self, kind: ProviderKind) -> bool {
        match &self.installed {
            Some(installed) => installed.contains(&kind),
            None => self.accounts.iter().any(|holding| holding.terminal && holding.kind == kind),
        }
    }
}

/// The harnesses installed on this machine, by its own settings (a custom binary counts).
fn installed_here(state: &AppState) -> Vec<ProviderKind> {
    let settings = state.settings.get();
    ProviderKind::ALL
        .into_iter()
        .filter(|kind| {
            let provider = crate::settings::provider_settings(&settings, *kind, None);
            let binary = provider.binary.map(std::path::PathBuf::from);
            if *kind == ProviderKind::Cursor {
                kybern_drivers::cursor::installed(&kybern_drivers::ProbeContext { binary: None, cwd: None, env: provider.env })
            } else {
                kybern_drivers::binary::resolve(*kind, binary.as_ref()).is_ok()
            }
        })
        .collect()
}

// ---- entities ----

fn flatten(shared: &AccountsShared) -> BTreeMap<String, Value> {
    let mut out = BTreeMap::new();
    for (key, profile) in &shared.profiles {
        out.insert(format!("profile:{key}"), serde_json::to_value(profile).unwrap_or(Value::Null));
    }
    for (kind, key) in &shared.defaults {
        out.insert(format!("default:{}", kind.as_str()), Value::String(key.clone()));
    }
    for (repo, kinds) in &shared.projects {
        for (kind, key) in kinds {
            out.insert(format!("project:{}:{repo}", kind.as_str()), Value::String(key.clone()));
        }
    }
    for (id, dismissal) in &shared.offers {
        out.insert(format!("offer:{id}"), serde_json::to_value(dismissal).unwrap_or(Value::Null));
    }
    out
}

/// Put one register into `shared`. Returns false for an entity or value that does not fit.
fn apply_entity(shared: &mut AccountsShared, entity: &str, value: &Value) -> bool {
    let key_value = || value.as_str().filter(|key| crate::accounts_shared::parse_key(key).is_some()).map(str::to_string);
    if let Some(key) = entity.strip_prefix("profile:") {
        if crate::accounts_shared::parse_key(key).is_none() {
            return false;
        }
        match value {
            Value::Null => true,
            _ => match serde_json::from_value::<AccountProfile>(value.clone()) {
                Ok(profile) => {
                    shared.profiles.insert(key.to_string(), profile);
                    true
                }
                Err(_) => false,
            },
        }
    } else if let Some(kind) = entity.strip_prefix("default:") {
        let Ok(kind) = kind.parse::<ProviderKind>() else { return false };
        match value {
            Value::Null => true,
            _ => key_value()
                .filter(|key| key.starts_with(&format!("{}:", kind.as_str())))
                .map(|key| shared.defaults.insert(kind, key))
                .is_some(),
        }
    } else if let Some(rest) = entity.strip_prefix("project:") {
        let Some((kind, repo)) = rest.split_once(':') else { return false };
        let Ok(kind) = kind.parse::<ProviderKind>() else { return false };
        if repo.is_empty() || repo.len() > 300 {
            return false;
        }
        match value {
            Value::Null => true,
            _ => key_value()
                .filter(|key| key.starts_with(&format!("{}:", kind.as_str())))
                .map(|key| shared.projects.entry(repo.to_string()).or_default().insert(kind, key))
                .is_some(),
        }
    } else if let Some(id) = entity.strip_prefix("offer:") {
        if id.is_empty() || id.len() > 200 {
            return false;
        }
        match value {
            Value::Null => true,
            _ => match serde_json::from_value::<OfferDismissal>(value.clone()) {
                Ok(dismissal) if dismissal.fingerprint.len() <= 128 => {
                    shared.offers.insert(id.to_string(), dismissal);
                    true
                }
                _ => false,
            },
        }
    } else {
        false
    }
}

fn holdings_of(entity: &str) -> Option<&str> {
    entity.strip_prefix("holdings:").filter(|id| !id.is_empty() && id.len() <= 64)
}

fn valid(entity: &str, value: &Value, signer: &str) -> bool {
    if let Some(machine) = holdings_of(entity) {
        return machine == signer
            && serde_json::from_value::<MachineHoldings>(value.clone()).is_ok_and(|holdings| holdings.accounts.len() <= MAX_HOLDINGS);
    }
    apply_entity(&mut AccountsShared::default(), entity, value)
}

fn parse(e: &OpEnvelope) -> anyhow::Result<SpaceField> {
    Ok(serde_json::from_str(&e.body)?)
}

fn stamp(e: &OpEnvelope) -> Option<(u64, String, String)> {
    parse(e).ok().map(|f| (f.lamport, e.signer.clone(), e.id.clone()))
}

fn registers(state: &AppState) -> anyhow::Result<Registers> {
    Ok(state.store.meta_get(KEY)?.map(|text| serde_json::from_str(&text)).transpose()?.unwrap_or_default())
}

fn baseline(state: &AppState) -> anyhow::Result<Option<BTreeMap<String, Value>>> {
    Ok(state.store.meta_get(BASE)?.map(|text| serde_json::from_str(&text)).transpose()?)
}

/// What the registers say `accounts_shared` is.
fn projection(all: &Registers) -> AccountsShared {
    let mut shared = AccountsShared::default();
    for (entity, e) in all {
        if holdings_of(entity).is_some() {
            continue;
        }
        if let Ok(f) = parse(e) {
            apply_entity(&mut shared, entity, &f.value);
        }
    }
    shared
}

// ---- this machine's holdings ----

/// This machine's own holdings, as last published.
pub fn own_holdings(state: &AppState) -> MachineHoldings {
    state.store.meta_get(SELF_HOLDINGS).ok().flatten().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default()
}

/// Record what this machine holds, from a full account list. The next sync pass sends it.
pub fn publish_holdings(state: &AppState, accounts: &[AccountSummary]) {
    let mut holdings = MachineHoldings {
        premigration: crate::accounts_shared::premigration(&state.store),
        installed: Some(installed_here(state)),
        threads: state.store.thread_provider_kinds().ok(),
        ..Default::default()
    };
    for summary in accounts {
        // A harness that isn't installed has nothing to say about its terminal login.
        if summary.terminal && summary.status == AccountStatus::Unknown {
            continue;
        }
        if holdings.accounts.len() >= MAX_HOLDINGS {
            break;
        }
        holdings.accounts.push(Holding {
            kind: summary.provider.kind,
            instance: summary.provider.instance.clone(),
            key: summary.key.clone(),
            terminal: summary.terminal,
            status: summary.status,
            borrowed_from: summary.broker.as_ref().filter(|broker| !broker.machine_id.is_empty()).map(|broker| broker.machine_id.clone()),
        });
    }
    if own_holdings(state) != holdings
        && let Ok(text) = serde_json::to_string(&holdings)
    {
        let _ = state.store.meta_set(SELF_HOLDINGS, &text);
    }
}

/// What every machine holds, by machine: the registers, with this machine's own current holdings.
pub fn all_holdings(state: &AppState) -> BTreeMap<MachineId, MachineHoldings> {
    let mut out = BTreeMap::new();
    for (entity, e) in registers(state).unwrap_or_default() {
        if let (Some(machine), Ok(f)) = (holdings_of(&entity), parse(&e))
            && let Ok(holdings) = serde_json::from_value::<MachineHoldings>(f.value)
        {
            out.insert(machine.to_string(), holdings);
        }
    }
    let me = state.network.machine_id().unwrap_or_else(|| state.environment_id.clone());
    let mut mine = own_holdings(state);
    mine.premigration = crate::accounts_shared::premigration(&state.store);
    out.insert(me, mine);
    out
}

/// The key of a lender's account (`broker_account` on `machine`), from its holdings.
pub fn lender_key(state: &AppState, machine: &str, kind: ProviderKind, instance: &str) -> Option<String> {
    all_holdings(state).get(machine)?.accounts.iter().find(|holding| holding.kind == kind && holding.instance == instance)?.key.clone()
}

// ---- observe and merge ----

fn active(state: &AppState) -> Option<&super::Membership> {
    state.network.membership().map(Arc::as_ref).filter(|m| m.self_is_member() && !m.key_mismatch())
}

fn next_clock(all: &Registers) -> u64 {
    all.values().filter_map(|e| parse(e).ok()).map(|f| f.lamport).max().unwrap_or(0).saturating_add(1)
}

/// Seal what changed here since the last sync: `accounts_shared` against the baseline, and this machine's holdings.
fn observe(state: &AppState) -> anyhow::Result<Registers> {
    let mut all = registers(state)?;
    let Some(m) = active(state) else { return Ok(all) };
    let me = m.machine_id();
    let stored = baseline(state)?;
    // The first sealing is this machine's import: clock zero, below any edit made since.
    let import = stored.is_none();
    let mut base = stored.unwrap_or_default();
    let current = flatten(&state.settings.get().accounts_shared);
    let entities: Vec<String> = current.keys().chain(base.keys()).cloned().collect::<std::collections::BTreeSet<_>>().into_iter().collect();
    for entity in entities {
        let now = current.get(&entity).cloned().unwrap_or(Value::Null);
        if base.get(&entity).cloned().unwrap_or(Value::Null) == now {
            continue;
        }
        let held = all.get(&entity).and_then(|e| parse(e).ok()).map(|f| f.value);
        if held.as_ref() != Some(&now) {
            if !all.contains_key(&entity) && all.len() >= MAX_REGISTERS {
                continue;
            }
            let clock = if import { 0 } else { next_clock(&all) };
            all.insert(entity.clone(), spaces::seal(m, clock, entity.clone(), FIELD, now.clone())?);
        }
        if now.is_null() {
            base.remove(&entity);
        } else {
            base.insert(entity, now);
        }
    }
    let entity = format!("holdings:{me}");
    let mine = serde_json::to_value(own_holdings(state))?;
    let held = all.get(&entity).filter(|e| e.signer == me).and_then(|e| parse(e).ok()).map(|f| f.value);
    if held.as_ref() != Some(&mine) && (all.contains_key(&entity) || all.len() < MAX_REGISTERS) {
        let clock = next_clock(&all);
        all.insert(entity.clone(), spaces::seal(m, clock, entity, FIELD, mine)?);
    }
    state.store.meta_set(KEY, &serde_json::to_string(&all)?)?;
    state.store.meta_set(BASE, &serde_json::to_string(&base)?)?;
    Ok(all)
}

/// Take in registers from another machine, then write the result to `accounts_shared`.
fn merge(state: &AppState, mut all: Registers, incoming: &[OpEnvelope]) -> anyhow::Result<Registers> {
    anyhow::ensure!(incoming.len() <= MAX_REGISTERS, "Too many account registers");
    let m = state.network.membership().ok_or_else(|| anyhow::anyhow!("No network"))?;
    let projection_now = m.projection();
    for e in incoming {
        anyhow::ensure!(e.body.len() <= MAX_BODY && e.id == ops::op_id(&e.body), "Invalid account register hash or size");
        let f = parse(e)?;
        anyhow::ensure!(f.field == FIELD && f.lamport < i64::MAX as u64, "Invalid account register field");
        anyhow::ensure!(
            projection_now.network_id.as_ref() == Some(&f.network_id) || projection_now.merged_networks.contains(&f.network_id),
            "Foreign account register network"
        );
        let signer = projection_now.entry(&e.signer).ok_or_else(|| anyhow::anyhow!("Account register signer is not a member"))?;
        keys::verify_signature(&signer.descriptor.signing_key, &spaces::input(&e.body), &B64.decode(&e.signature)?)?;
        // A register this version does not understand is skipped, so a newer machine can add kinds.
        if !valid(&f.entity, &f.value, &e.signer) {
            continue;
        }
        if !all.contains_key(&f.entity) && all.len() >= MAX_REGISTERS {
            continue;
        }
        if all.get(&f.entity).is_none_or(|old| stamp(old) < stamp(e)) {
            all.insert(f.entity, e.clone());
        }
    }
    state.store.meta_set(KEY, &serde_json::to_string(&all)?)?;
    let shared = flatten(&projection(&all));
    // `observe` just left the baseline at the settings it read. A value changed here since (a write that
    // landed while this pass ran) is not sealed yet: it stays, with its old baseline, so the next pass seals
    // it instead of this one undoing it.
    let base = baseline(state)?.unwrap_or_default();
    let mut next_base = None;
    let applied = state.settings.update(|settings| {
        let (values, base) = keep_unsealed(&shared, &base, &flatten(&settings.accounts_shared));
        next_base = Some(base);
        let mut merged = AccountsShared::default();
        for (entity, value) in &values {
            apply_entity(&mut merged, entity, value);
        }
        (settings.accounts_shared != merged).then(|| {
            let mut next = settings.clone();
            next.accounts_shared = merged;
            (next, ())
        })
    });
    if let Err(error) = applied {
        // The baseline stays, so the next pass tries again rather than sealing the old values.
        tracing::warn!(target: super::TARGET, %error, "could not apply the shared accounts");
        return Ok(all);
    }
    // What normalize added for this machine's own accounts differs from this and is sealed next time.
    if let Some(base) = next_base {
        state.store.meta_set(BASE, &serde_json::to_string(&base)?)?;
    }
    Ok(all)
}

/// The values to write and the baseline to keep, from what the registers say (`shared`), the baseline
/// `observe` left (`base`) and the settings now (`local`): an entity whose local value moved off its
/// baseline was changed after `observe` read it, so it keeps its local value and its old baseline.
fn keep_unsealed(
    shared: &BTreeMap<String, Value>,
    base: &BTreeMap<String, Value>,
    local: &BTreeMap<String, Value>,
) -> (BTreeMap<String, Value>, BTreeMap<String, Value>) {
    let mut values = shared.clone();
    let mut next_base = shared.clone();
    for entity in local.keys().chain(base.keys()) {
        let now = local.get(entity);
        let before = base.get(entity);
        if now == before {
            continue;
        }
        match now {
            Some(value) => values.insert(entity.clone(), value.clone()),
            None => values.remove(entity),
        };
        match before {
            Some(value) => next_base.insert(entity.clone(), value.clone()),
            None => next_base.remove(entity),
        };
    }
    (values, next_base)
}

pub async fn serve(state: &AppState, p: PeerSpacesSyncParams) -> Result<PeerSpacesSyncResult, RpcError> {
    let _guard = state.network.spaces_lock.lock().await;
    let local = observe(state).map_err(RpcError::internal)?;
    let all = merge(state, local, &p.fields).map_err(RpcError::invalid_params)?;
    let ids: Vec<_> = all.values().map(|e| e.id.clone()).collect();
    let fields = all.into_values().filter(|e| !p.ids.contains(&e.id)).collect();
    Ok(PeerSpacesSyncResult { digest: ops::digest_of(&ids), ids, fields })
}

pub async fn sync(state: &AppState, link: &Arc<PeerLink>) {
    if !state.network.peers.status(&link.machine_id).presence.is_some_and(|p| p.features.iter().any(|f| f == features::ACCOUNTS_SYNC_V1)) {
        return;
    }
    let local = {
        let _guard = state.network.spaces_lock.lock().await;
        observe(state)
    };
    let Ok(local) = local else { return };
    let ids: Vec<_> = local.values().map(|e| e.id.clone()).collect();
    let p = PeerSpacesSyncParams { digest: ops::digest_of(&ids), ids, fields: local.into_values().collect() };
    let Ok(answer) = link.call::<PeerAccountsSync>(p).await else { return };
    let _guard = state.network.spaces_lock.lock().await;
    if let Ok(local) = observe(state)
        && let Err(error) = merge(state, local, &answer.fields)
    {
        tracing::warn!(target: super::TARGET, machine = %link.machine_id, %error, "could not take the shared accounts");
    }
}

/// Seal local changes now (also outside a pass), for tests and after a local write.
#[cfg(test)]
pub(crate) fn observe_now(state: &AppState) -> anyhow::Result<()> {
    observe(state).map(|_| ())
}

/// Apply `incoming` and write the result, as the end of a pass does, for tests.
#[cfg(test)]
pub(crate) fn merge_now(state: &AppState, incoming: &[OpEnvelope]) -> anyhow::Result<()> {
    merge(state, registers(state)?, incoming).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn holdings_say_which_harnesses_are_installed_here() {
        let root = std::env::temp_dir().join(format!("kybern-holdings-{}", uuid::Uuid::now_v7()));
        let paths = crate::config::Paths::resolve(Some(root.join("data"))).unwrap();
        let state = AppState::initialize(&paths).unwrap();
        let binary = root.join("claude-stand-in");
        std::fs::write(&binary, b"").unwrap();
        let mut settings = state.settings.get();
        settings.providers.entry(ProviderKind::ClaudeCode).or_default().binary = Some(binary.to_string_lossy().into_owned());
        settings.providers.entry(ProviderKind::Codex).or_default().binary = Some(root.join("missing").to_string_lossy().into_owned());
        state.settings.set(settings).unwrap();
        publish_holdings(&state, &[]);
        let holdings = own_holdings(&state);
        assert!(holdings.has_installed(ProviderKind::ClaudeCode));
        assert!(!holdings.has_installed(ProviderKind::Codex), "the binary its settings name isn't there");
        assert_eq!(holdings.threads, Some(Vec::new()));
        // An older daemon says nothing: other machines read its terminal logins instead.
        let older: MachineHoldings = serde_json::from_str(r#"{"accounts":[]}"#).unwrap();
        assert!(older.installed.is_none() && older.threads.is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn every_shared_value_round_trips_through_its_registers() {
        let mut shared = AccountsShared::default();
        shared.profiles.insert(
            "claude-code:me@example.com".into(),
            AccountProfile { name: "Me".into(), color: Some("teal".into()), manual_only: true },
        );
        shared.defaults.insert(ProviderKind::Codex, "codex:me@example.com".into());
        shared.projects.entry("root:abc".into()).or_default().insert(ProviderKind::ClaudeCode, "claude-code:me@example.com".into());
        shared
            .offers
            .insert("always_on:m1".into(), OfferDismissal { state: kybern_protocol::OfferDismissalState::Later, fingerprint: "f".into() });
        let mut back = AccountsShared::default();
        for (entity, value) in flatten(&shared) {
            assert!(apply_entity(&mut back, &entity, &value), "{entity}");
        }
        assert_eq!(back, shared);
        assert!(!apply_entity(&mut back, "default:codex", &Value::String("claude-code:me@example.com".into())));
        assert!(!apply_entity(&mut back, "nonsense", &Value::Null));
        assert!(!valid("holdings:m1", &serde_json::to_value(MachineHoldings::default()).unwrap(), "m2"), "only m1 signs its holdings");
        assert!(valid("holdings:m1", &serde_json::to_value(MachineHoldings::default()).unwrap(), "m1"));
    }

    #[test]
    fn a_value_changed_after_observe_is_kept_and_left_unsealed() {
        let map = |pairs: &[(&str, &str)]| -> BTreeMap<String, Value> {
            pairs.iter().map(|(k, v)| (k.to_string(), Value::String(v.to_string()))).collect()
        };
        // The registers say personal; observe saw personal; the user has since chosen work and added a project.
        let shared = map(&[("default:claude-code", "personal"), ("offer:x", "o")]);
        let base = map(&[("default:claude-code", "personal"), ("offer:gone", "g")]);
        let local = map(&[("default:claude-code", "work"), ("project:claude-code:r", "w")]);
        let (values, next_base) = keep_unsealed(&shared, &base, &local);
        // Kept: the new default and project; the removal of `offer:gone` here stays removed.
        assert_eq!(values, map(&[("default:claude-code", "work"), ("offer:x", "o"), ("project:claude-code:r", "w")]));
        // Still unsealed: the baseline keeps what observe saw, so the next observe seals all three.
        assert_eq!(next_base, map(&[("default:claude-code", "personal"), ("offer:gone", "g"), ("offer:x", "o")]));
        // Nothing changed since observe: the registers win.
        let (values, next_base) = keep_unsealed(&shared, &base, &base);
        assert_eq!(values, shared);
        assert_eq!(next_base, shared);
    }
}
