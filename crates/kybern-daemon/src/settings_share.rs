//! Settings fan-out across the machine network (ADE-86 M5 / S1, design §9.1).
//!
//! * **Classification.** Every `Settings` field is [`Sharing::Shared`] or [`Sharing::PerMachine`], and a
//!   provider's fields likewise. The tables below are written once, by a macro that also destructures
//!   `Settings` and `ProviderSettings` without `..`: a field added to either struct does not compile until
//!   it is classified here. Per-machine fields (binaries, `env`, accounts, ports, access…) never leave the
//!   machine: `peer.settings.get` lists shared fields only and `peer.settings.patch` refuses any other path.
//! * **Stamps.** A change to a shared field carries a [`SettingsStamp`], ordered by `(at, lamport,
//!   machine_id)`. Each machine keeps the stamp and value of the last change of each shared field in
//!   `meta` (`settings.stamp.<path>`). Every change made on this machine, by whatever route, is stamped by
//!   [`note_local_change`] (called from `SettingsStore::set`), so a patch that waited in the outbox while the
//!   field was changed here is older than that change and does not apply.
//! * **Fan-out.** `settings.share` applies the fields here with one fresh stamp and queues a
//!   `settings_patch` outbox item per other member; the outbox worker delivers it the moment the member is
//!   reachable, so an online machine gets it at once and an offline one when it returns. Nothing syncs on
//!   its own: only an explicit user change fans out, and differing values stay visible as **Mixed**
//!   ([`network_view`]).

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;
use std::time::Duration;

use chrono::{DateTime, Utc};
use kybern_protocol::methods::{Method, PeerSettingsGet, PeerSettingsPatch};
use kybern_protocol::*;
use kybern_store::Store;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::orchestrator::remote_delegation::{CallFailure, Delivery, MemberView};
use crate::state::AppState;

/// How long a machine has to answer `peer.settings.get`.
const VIEW_WAIT: Duration = Duration::from_secs(5);

const LAMPORT_KEY: &str = "settings.lamport";
const CLOCK_KEY: &str = "settings.clock";

fn stamp_key(path: &str) -> String {
    format!("settings.stamp.{path}")
}

// ---- classification ----

/// Whether a field is the same on every machine or belongs to one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sharing {
    /// One value for the network: a user change fans out to every machine.
    Shared,
    /// This machine's own: paths, credentials, ports, what it exposes.
    PerMachine,
    /// A map by provider; see [`PROVIDER_FIELDS`] for what inside each entry is shared.
    PerProvider,
}

macro_rules! classify {
    ($table:ident, $guard:ident, $ty:path, { $($field:ident => $sharing:ident),* $(,)? }) => {
        pub const $table: &[(&str, Sharing)] = &[$((stringify!($field), Sharing::$sharing)),*];

        /// Destructures every field without `..`, so adding one to the struct breaks the build here.
        #[allow(dead_code)]
        fn $guard(value: &$ty) {
            let $ty { $($field: _),* } = value;
        }
    };
}

classify!(SETTINGS_FIELDS, every_settings_field_is_classified, Settings, {
    default_provider => Shared,
    default_permission_mode => Shared,
    worktrees_default => Shared,
    automatic_worktree_cleanup => Shared,
    generate_titles => Shared,
    title_provider => Shared,
    providers => PerProvider,
    notifications => Shared,
    auto_update_harnesses => Shared,
    auto_update_daemon => Shared,
    update_track => Shared,
    background => PerMachine,
    access => PerMachine,
    computer_use => PerMachine,
    orchestration => Shared,
    tell_agents_about_kybern => Shared,
    ask_deadlines => Shared,
    preview_allowed_folders => PerMachine,
    network => PerMachine,
});

classify!(PROVIDER_FIELDS, every_provider_field_is_classified, ProviderSettings, {
    accounts => PerMachine,
    default_account => PerMachine,
    project_accounts => PerMachine,
    binary => PerMachine,
    model => Shared,
    env => PerMachine,
    project_profiles => PerMachine,
});

/// The path of a provider's shared default model.
pub fn provider_model_path(kind: ProviderKind) -> String {
    format!("providers.{}.model", kind.as_str())
}

/// Every shared field path, in a fixed order: the top-level shared fields, then each provider's model.
pub fn shared_paths() -> Vec<String> {
    let shared = |table: &[(&str, Sharing)]| table.iter().any(|(_, sharing)| *sharing == Sharing::Shared);
    debug_assert!(shared(SETTINGS_FIELDS) && shared(PROVIDER_FIELDS));
    let mut paths: Vec<String> =
        SETTINGS_FIELDS.iter().filter(|(_, sharing)| *sharing == Sharing::Shared).map(|(name, _)| (*name).to_string()).collect();
    if PROVIDER_FIELDS.iter().any(|(name, sharing)| *name == "model" && *sharing == Sharing::Shared) {
        paths.extend(ProviderKind::ALL.into_iter().map(provider_model_path));
    }
    paths
}

/// The provider a `providers.<kind>.model` path names.
fn provider_of(path: &str) -> Option<ProviderKind> {
    let kind = path.strip_prefix("providers.")?.strip_suffix(".model")?;
    ProviderKind::ALL.into_iter().find(|candidate| candidate.as_str() == kind)
}

/// One shared field's current value (`null` when an optional field is unset).
pub fn get_shared(settings: &Settings, path: &str) -> Value {
    if let Some(kind) = provider_of(path) {
        return settings.providers.get(&kind).and_then(|provider| provider.model.clone()).map_or(Value::Null, Value::String);
    }
    serde_json::to_value(settings).ok().and_then(|value| value.get(path).cloned()).unwrap_or(Value::Null)
}

/// Set one shared field, checking that the value fits it.
fn set_shared(settings: &mut Settings, path: &str, value: &Value) -> Result<(), String> {
    if let Some(kind) = provider_of(path) {
        let model = match value {
            Value::Null => None,
            Value::String(model) if model.len() <= 256 => Some(model.clone()),
            _ => return Err("A model is text of at most 256 characters, or null.".into()),
        };
        settings.providers.entry(kind).or_default().model = model;
        return Ok(());
    }
    let mut whole = serde_json::to_value(&*settings).map_err(|error| error.to_string())?;
    let object = whole.as_object_mut().ok_or("settings are not an object")?;
    object.insert(path.to_string(), value.clone());
    *settings = serde_json::from_value(whole).map_err(|error| format!("That value does not fit {path}: {error}"))?;
    Ok(())
}

// ---- stamps ----

/// Serializes the read-modify-write of the stamp registers. Held only around `meta` reads and writes,
/// never across `SettingsStore::set`, which calls [`note_local_change`] itself.
static REGISTERS: Mutex<()> = Mutex::new(());

fn registers() -> std::sync::MutexGuard<'static, ()> {
    REGISTERS.lock().unwrap_or_else(|error| error.into_inner())
}

/// What a machine remembers about the last change of one shared field.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Recorded {
    stamp: SettingsStamp,
    value: Value,
}

fn read_recorded(store: &Store, path: &str) -> Option<Recorded> {
    let text = store.meta_get(&stamp_key(path)).ok().flatten().filter(|text| !text.is_empty())?;
    serde_json::from_str(&text).ok()
}

fn write_recorded(store: &Store, path: &str, recorded: Option<&Recorded>) {
    let text = recorded.and_then(|recorded| serde_json::to_string(recorded).ok()).unwrap_or_default();
    if let Err(error) = store.meta_set(&stamp_key(path), &text) {
        tracing::warn!(target: crate::network::TARGET, %error, path, "could not record a settings stamp");
    }
}

fn read_counter(store: &Store, key: &str) -> Option<String> {
    store.meta_get(key).ok().flatten()
}

/// A stamp newer than every one this machine has made or seen. Caller holds [`REGISTERS`].
fn next_stamp_locked(store: &Store) -> SettingsStamp {
    let lamport = read_counter(store, LAMPORT_KEY).and_then(|text| text.parse::<u64>().ok()).unwrap_or(0) + 1;
    let seen = read_counter(store, CLOCK_KEY).and_then(|text| DateTime::parse_from_rfc3339(&text).ok()).map(|at| at.with_timezone(&Utc));
    let now = Utc::now();
    // A clock that ran behind a stamp this machine has seen must not make a later change look older.
    let at = seen.filter(|seen| *seen >= now).map_or(now, |seen| seen + chrono::Duration::microseconds(1));
    let _ = store.meta_set(LAMPORT_KEY, &lamport.to_string());
    let _ = store.meta_set(CLOCK_KEY, &at.to_rfc3339());
    SettingsStamp { at, lamport, machine_id: store.meta_get("environment_id").ok().flatten().unwrap_or_default() }
}

/// Take in a stamp made elsewhere, so the next local one is newer. Caller holds [`REGISTERS`].
fn observe_locked(store: &Store, stamp: &SettingsStamp) {
    let lamport = read_counter(store, LAMPORT_KEY).and_then(|text| text.parse::<u64>().ok()).unwrap_or(0);
    if stamp.lamport > lamport {
        let _ = store.meta_set(LAMPORT_KEY, &stamp.lamport.to_string());
    }
    let seen = read_counter(store, CLOCK_KEY).and_then(|text| DateTime::parse_from_rfc3339(&text).ok()).map(|at| at.with_timezone(&Utc));
    if seen.is_none_or(|seen| stamp.at > seen) {
        let _ = store.meta_set(CLOCK_KEY, &stamp.at.to_rfc3339());
    }
}

pub fn next_stamp(store: &Store) -> SettingsStamp {
    let _held = registers();
    next_stamp_locked(store)
}

/// Stamp the shared fields that `before` → `after` changed. `SettingsStore::set` calls it after every
/// write, so a change made here by any route outranks a patch that was made earlier and is still on its
/// way. A field whose new value is the one a patch just recorded keeps that patch's stamp.
pub fn note_local_change(store: &Store, before: &Settings, after: &Settings) {
    let _held = registers();
    for path in shared_paths() {
        let (old, new) = (get_shared(before, &path), get_shared(after, &path));
        if old == new || read_recorded(store, &path).is_some_and(|recorded| recorded.value == new) {
            continue;
        }
        let stamp = next_stamp_locked(store);
        write_recorded(store, &path, Some(&Recorded { stamp, value: new }));
    }
}

// ---- applying a patch (the target side) ----

/// Apply the fields of `patch` that are shared, valid and newer than what this machine holds.
pub fn apply_patch(state: &AppState, patch: SettingsPatch) -> PeerSettingsPatchResult {
    let mut result = PeerSettingsPatchResult::default();
    let shared: BTreeSet<String> = shared_paths().into_iter().collect();
    let current = state.settings.get();
    let mut next = current.clone();
    let mut previous: Vec<(String, Option<Recorded>)> = Vec::new();
    {
        let _held = registers();
        observe_locked(&state.store, &patch.stamp);
        for (path, value) in &patch.fields {
            if !shared.contains(path) {
                result.refused.insert(path.clone(), format!("{path} is not a shared setting; each machine keeps its own."));
                continue;
            }
            let recorded = read_recorded(&state.store, path);
            match recorded.as_ref().map(|recorded| recorded.stamp.cmp(&patch.stamp)) {
                Some(std::cmp::Ordering::Equal) => {
                    result.unchanged.push(path.clone());
                    continue;
                }
                Some(std::cmp::Ordering::Greater) => {
                    result.stale.push(path.clone());
                    continue;
                }
                _ => {}
            }
            if let Err(reason) = set_shared(&mut next, path, value) {
                result.refused.insert(path.clone(), reason);
                continue;
            }
            // Recorded before the write, so the write's own `note_local_change` leaves the stamp alone.
            write_recorded(&state.store, path, Some(&Recorded { stamp: patch.stamp.clone(), value: get_shared(&next, path) }));
            previous.push((path.clone(), recorded));
            if get_shared(&current, path) == get_shared(&next, path) {
                result.unchanged.push(path.clone());
            } else {
                result.applied.push(path.clone());
            }
        }
    }
    if result.applied.is_empty() {
        return result;
    }
    match state.settings.set(next) {
        Ok(_) => state.orchestrator.usage().settings_changed(),
        Err(error) => {
            let _held = registers();
            for (path, recorded) in previous {
                write_recorded(&state.store, &path, recorded.as_ref());
            }
            let reason = format!("{error:#}");
            for path in std::mem::take(&mut result.applied) {
                result.refused.insert(path, reason.clone());
            }
        }
    }
    result
}

/// `peer.settings.get`: the shared settings of this machine, never the per-machine ones.
pub fn peer_get(state: &AppState) -> PeerSettingsGetResult {
    let settings = state.settings.get();
    let mut result = PeerSettingsGetResult::default();
    for path in shared_paths() {
        result.values.insert(path.clone(), get_shared(&settings, &path));
        if let Some(recorded) = read_recorded(&state.store, &path) {
            result.stamps.insert(path, recorded.stamp);
        }
    }
    result
}

// ---- sharing (the client side) ----

fn invalid(message: impl Into<String>) -> RpcError {
    RpcError::invalid_params(message.into())
}

/// A shared patch that fits the shared fields, or why it does not: used by `settings.share` and when the
/// outbox accepts a `settings_patch` item.
pub fn check_patch(patch: &SettingsPatch) -> Result<(), RpcError> {
    if patch.fields.is_empty() {
        return Err(invalid("Choose at least one setting to share."));
    }
    let shared: BTreeSet<String> = shared_paths().into_iter().collect();
    let mut probe = Settings::default();
    for (path, value) in &patch.fields {
        if !shared.contains(path) {
            return Err(invalid(format!("{path} is not a shared setting; each machine keeps its own.")));
        }
        set_shared(&mut probe, path, value).map_err(invalid)?;
    }
    Ok(())
}

/// `settings.share`: change shared fields here and queue the change for the other machines.
pub async fn share(state: &AppState, params: SettingsShareParams) -> Result<SettingsShareResult, RpcError> {
    let stamp = next_stamp(&state.store);
    let patch = SettingsPatch { stamp: stamp.clone(), fields: params.fields };
    check_patch(&patch)?;
    let hub = state.orchestrator.remote_hub().cloned();
    // Resolve the chosen machines first, so a typo changes nothing.
    let members: Vec<MemberView> =
        hub.as_ref().map(|hub| hub.members()).unwrap_or_default().into_iter().filter(|member| !member.is_self).collect();
    let chosen: Vec<MemberView> = match (&params.machines, &hub) {
        (None, _) => members,
        (Some(wanted), Some(hub)) => {
            let mut chosen = Vec::new();
            for query in wanted {
                let target = hub.resolve(query).map_err(|reason| RpcError::new(codes::NOT_FOUND, reason))?;
                if let Some(member) = members.iter().find(|member| member.id == target.id)
                    && !chosen.iter().any(|known: &MemberView| known.id == member.id)
                {
                    chosen.push(member.clone());
                }
            }
            chosen
        }
        (Some(wanted), None) if wanted.is_empty() => Vec::new(),
        (Some(_), None) => return Err(RpcError::new(codes::NOT_AVAILABLE, "the machine network is not available")),
    };
    let here = apply_patch(state, patch.clone());
    if !here.refused.is_empty() {
        let reasons: Vec<&str> = here.refused.values().map(String::as_str).collect();
        return Err(invalid(reasons.join(" ")));
    }
    let mut machines = Vec::new();
    for member in chosen {
        // A machine that has listed its features and lacks this one cannot take the patch yet; one that has
        // not listed any (offline, no presence) gets it queued and takes it when it comes back.
        if !member.features.is_empty() && !member.features.iter().any(|feature| feature == features::SETTINGS_FANOUT_V1) {
            machines.push(SettingsShareTarget {
                machine_id: member.id,
                name: member.name,
                state: SettingsShareState::Unsupported,
                outbox_id: None,
            });
            continue;
        }
        supersede_queued(state, &member.id, &patch);
        let item = crate::network::outbox::enqueue(
            state,
            OutboxEnqueueParams {
                target: member.id.clone(),
                operation: OutboxOp {
                    kind: OutboxKind::SettingsPatch,
                    payload: serde_json::to_value(&patch).map_err(RpcError::internal)?,
                    operation_id: None,
                },
            },
        )?;
        machines.push(SettingsShareTarget {
            machine_id: member.id,
            name: member.name,
            state: SettingsShareState::Queued,
            outbox_id: Some(item.id),
        });
    }
    Ok(SettingsShareResult { stamp, here, machines })
}

/// Cancel what is queued for `target` that this patch replaces: a queued patch whose fields this one sets
/// again. Without it a machine that stays offline for days would collect every change the user ever made.
fn supersede_queued(state: &AppState, target: &str, patch: &SettingsPatch) {
    let queued = state.store.outbox_list(Some(target), Some(OutboxState::Queued)).unwrap_or_default();
    for item in queued.into_iter().filter(|item| item.kind == OutboxKind::SettingsPatch) {
        let Ok(old) = serde_json::from_value::<SettingsPatch>(item.payload.clone()) else { continue };
        if old.fields.keys().all(|path| patch.fields.contains_key(path)) {
            let _ = crate::network::outbox::cancel(state, OutboxIdParams { id: item.id });
        }
    }
}

// ---- delivery (the outbox worker) ----

/// Deliver a queued `settings_patch` item: `peer.settings.patch` on the target. A patch is idempotent by
/// its stamp, so a repeated delivery changes nothing.
pub async fn deliver(state: &AppState, item: &OutboxItem) -> Delivery {
    let Some(hub) = state.orchestrator.remote_hub().cloned() else {
        return Delivery::Failed("This daemon cannot reach other machines.".into());
    };
    if let Err(error) = serde_json::from_value::<SettingsPatch>(item.payload.clone()) {
        return Delivery::Failed(format!("The queued settings change is unreadable: {error}"));
    }
    match hub.call(&item.target, PeerSettingsPatch::NAME, item.payload.clone()).await {
        Ok(value) => Delivery::Delivered(value),
        Err(CallFailure::Offline(reason)) => Delivery::Retry(reason),
        Err(CallFailure::Gone(reason)) => Delivery::Failed(reason),
        Err(CallFailure::Remote(error)) => match error.code {
            // A Kybern without fan-out: the change waits for its update.
            codes::METHOD_NOT_FOUND => {
                Delivery::Retry("That machine needs a newer Kybern to take shared settings. Update it from Settings → Machines.".into())
            }
            codes::FORBIDDEN => {
                let name = hub.target(&item.target).map_or_else(|| "That machine".to_string(), |target| target.name);
                Delivery::Failed(format!(
                    "{name} does not let this machine change its settings. Turn Settings on for it in Settings → Machines on {name}, then retry."
                ))
            }
            codes::INTERNAL_ERROR | codes::THREAD_BUSY | codes::NOT_AVAILABLE => Delivery::Retry(error.message),
            _ => Delivery::Failed(error.message),
        },
    }
}

// ---- reading (the Mixed view) ----

/// `settings.network_view`: every shared field on this machine and on each member that answers.
pub async fn network_view(state: &AppState) -> SettingsNetworkView {
    let local = peer_get(state);
    let hub = state.orchestrator.remote_hub().cloned();
    let mut members = hub.as_ref().map(|hub| hub.members()).unwrap_or_default();
    let Some(hub) = hub.filter(|_| !members.is_empty()) else {
        // Not in a network: this machine alone.
        let me = SettingsMachineView {
            id: state.environment_id.clone(),
            name: crate::rpc::hostname(),
            is_self: true,
            state: SettingsMachineState::Reported,
        };
        return view_of(vec![(me, Some(local))], &BTreeMap::new());
    };
    members.sort_by(|a, b| b.is_self.cmp(&a.is_self).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    let asked = members.iter().map(|member| {
        let (hub, local) = (hub.clone(), local.clone());
        async move {
            let view = |state| SettingsMachineView { id: member.id.clone(), name: member.name.clone(), is_self: member.is_self, state };
            if member.is_self {
                return (view(SettingsMachineState::Reported), Some(local));
            }
            if member.status != "online" {
                return (view(SettingsMachineState::Offline), None);
            }
            if !member.features.is_empty() && !member.features.iter().any(|feature| feature == features::SETTINGS_FANOUT_V1) {
                return (view(SettingsMachineState::Unsupported), None);
            }
            let call = hub.call(&member.id, PeerSettingsGet::NAME, Value::Null);
            match tokio::time::timeout(VIEW_WAIT, call).await {
                Ok(Ok(value)) => match serde_json::from_value::<PeerSettingsGetResult>(value) {
                    Ok(answer) => (view(SettingsMachineState::Reported), Some(answer)),
                    Err(_) => (view(SettingsMachineState::Unreachable), None),
                },
                Ok(Err(CallFailure::Remote(error))) if error.code == codes::METHOD_NOT_FOUND => {
                    (view(SettingsMachineState::Unsupported), None)
                }
                _ => (view(SettingsMachineState::Unreachable), None),
            }
        }
    });
    let answers = futures::future::join_all(asked).await;
    view_of(answers, &pending_by_path(state))
}

/// For each field path, the machines with a change for it still in the outbox.
fn pending_by_path(state: &AppState) -> BTreeMap<String, Vec<MachineId>> {
    let mut pending: BTreeMap<String, Vec<MachineId>> = BTreeMap::new();
    for outbox_state in [OutboxState::Queued, OutboxState::Sending] {
        for item in state.store.outbox_list(None, Some(outbox_state)).unwrap_or_default() {
            if item.kind != OutboxKind::SettingsPatch {
                continue;
            }
            let Ok(patch) = serde_json::from_value::<SettingsPatch>(item.payload) else { continue };
            for path in patch.fields.into_keys() {
                let machines = pending.entry(path).or_default();
                if !machines.contains(&item.target) {
                    machines.push(item.target.clone());
                }
            }
        }
    }
    pending
}

/// Lay the answers out per field and decide which fields are Mixed.
fn view_of(
    answers: Vec<(SettingsMachineView, Option<PeerSettingsGetResult>)>,
    pending: &BTreeMap<String, Vec<MachineId>>,
) -> SettingsNetworkView {
    let fields = shared_paths()
        .into_iter()
        .map(|path| {
            let values: Vec<SettingsFieldValue> = answers
                .iter()
                .map(|(machine, answer)| SettingsFieldValue {
                    machine_id: machine.id.clone(),
                    value: answer.as_ref().map(|answer| answer.values.get(&path).cloned().unwrap_or(Value::Null)),
                })
                .collect();
            let reported: Vec<&Value> = values.iter().filter_map(|entry| entry.value.as_ref()).collect();
            let mixed = reported.windows(2).any(|pair| pair[0] != pair[1]);
            SettingsFieldView { pending: pending.get(&path).cloned().unwrap_or_default(), path, values, mixed }
        })
        .collect();
    SettingsNetworkView { machines: answers.into_iter().map(|(machine, _)| machine).collect(), fields }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_settings_and_provider_field_has_a_classification() {
        // The build already fails when a field is missing from the tables. This also checks the tables
        // against what the types actually serialize, and that no table names a field twice.
        let settings =
            Settings { title_provider: Some(ProviderKind::Codex), preview_allowed_folders: vec!["/tmp".into()], ..Settings::default() };
        let mut provider = ProviderSettings::default();
        provider.accounts.insert("work".into(), ProviderAccount::default());
        provider.default_account = Some("work".into());
        provider.project_accounts.insert("/p".into(), "work".into());
        provider.binary = Some("/bin/x".into());
        provider.model = Some("m".into());
        provider.env.insert("K".into(), "v".into());
        provider.project_profiles.insert("/p".into(), "x".into());
        let keys = |value: Value| -> BTreeSet<String> { value.as_object().unwrap().keys().cloned().collect() };
        let table = |table: &[(&str, Sharing)]| -> BTreeSet<String> { table.iter().map(|(name, _)| (*name).to_string()).collect() };
        assert_eq!(keys(serde_json::to_value(&settings).unwrap()), table(SETTINGS_FIELDS));
        assert_eq!(keys(serde_json::to_value(&provider).unwrap()), table(PROVIDER_FIELDS));
        assert_eq!(SETTINGS_FIELDS.len(), table(SETTINGS_FIELDS).len());
        assert_eq!(PROVIDER_FIELDS.len(), table(PROVIDER_FIELDS).len());
    }

    #[test]
    fn the_classification_follows_the_design() {
        let class = |name: &str| SETTINGS_FIELDS.iter().find(|(field, _)| *field == name).unwrap().1;
        for shared in [
            "default_provider",
            "default_permission_mode",
            "worktrees_default",
            "automatic_worktree_cleanup",
            "generate_titles",
            "title_provider",
            "notifications",
            "auto_update_harnesses",
            "auto_update_daemon",
            "update_track",
            "orchestration",
            "tell_agents_about_kybern",
            "ask_deadlines",
        ] {
            assert_eq!(class(shared), Sharing::Shared, "{shared}");
        }
        for own in ["background", "access", "computer_use", "preview_allowed_folders", "network"] {
            assert_eq!(class(own), Sharing::PerMachine, "{own}");
        }
        assert_eq!(class("providers"), Sharing::PerProvider);
        let provider = |name: &str| PROVIDER_FIELDS.iter().find(|(field, _)| *field == name).unwrap().1;
        assert_eq!(provider("model"), Sharing::Shared);
        for own in ["accounts", "default_account", "project_accounts", "binary", "env", "project_profiles"] {
            assert_eq!(provider(own), Sharing::PerMachine, "{own}");
        }
        let paths = shared_paths();
        assert!(paths.contains(&"providers.codex.model".to_string()) && paths.contains(&"providers.claude-code.model".to_string()));
        assert!(!paths.iter().any(|path| path.contains("env") || path.contains("binary") || path.contains("access")));
    }

    #[test]
    fn a_shared_field_reads_and_writes_by_path() {
        let mut settings = Settings::default();
        assert_eq!(get_shared(&settings, "notifications"), Value::Bool(true));
        set_shared(&mut settings, "notifications", &Value::Bool(false)).unwrap();
        assert!(!settings.notifications);
        assert_eq!(get_shared(&settings, "title_provider"), Value::Null);
        set_shared(&mut settings, "title_provider", &serde_json::json!("codex")).unwrap();
        assert_eq!(settings.title_provider, Some(ProviderKind::Codex));
        set_shared(&mut settings, "title_provider", &Value::Null).unwrap();
        assert_eq!(settings.title_provider, None);
        set_shared(&mut settings, "providers.codex.model", &serde_json::json!("gpt-x")).unwrap();
        assert_eq!(get_shared(&settings, "providers.codex.model"), serde_json::json!("gpt-x"));
        assert!(set_shared(&mut settings, "notifications", &serde_json::json!("yes")).is_err(), "a wrong type is refused");
        assert!(set_shared(&mut settings, "providers.codex.model", &serde_json::json!(4)).is_err());
        // Setting a model leaves the provider's per-machine fields alone.
        settings.providers.get_mut(&ProviderKind::Codex).unwrap().binary = Some("/bin/codex".into());
        set_shared(&mut settings, "providers.codex.model", &Value::Null).unwrap();
        assert_eq!(settings.providers[&ProviderKind::Codex].binary.as_deref(), Some("/bin/codex"));
    }

    #[test]
    fn a_patch_may_not_name_a_per_machine_field() {
        let stamp = SettingsStamp { at: Utc::now(), lamport: 1, machine_id: "a".into() };
        for path in ["providers.codex.env", "providers.codex.binary", "access", "network", "background", "computer_use", "nonsense"] {
            let patch = SettingsPatch { stamp: stamp.clone(), fields: BTreeMap::from([(path.to_string(), serde_json::json!(true))]) };
            let error = check_patch(&patch).unwrap_err();
            assert!(error.message.contains("not a shared setting"), "{path}: {}", error.message);
        }
        let empty = SettingsPatch { stamp, fields: BTreeMap::new() };
        assert!(check_patch(&empty).is_err());
    }

    #[test]
    fn stamps_order_by_time_then_counter_then_machine() {
        let at = Utc::now();
        let stamp = |offset: i64, lamport: u64, machine: &str| SettingsStamp {
            at: at + chrono::Duration::seconds(offset),
            lamport,
            machine_id: machine.into(),
        };
        assert!(stamp(1, 1, "a") > stamp(0, 9, "z"), "a later clock wins whatever the counter");
        assert!(stamp(0, 2, "a") > stamp(0, 1, "z"));
        assert!(stamp(0, 1, "b") > stamp(0, 1, "a"));
    }

    #[test]
    fn local_changes_are_stamped_and_a_newer_stamp_is_always_issued() {
        let dir = std::env::temp_dir().join(format!("kybern-share-test-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = Store::open(&dir.join("state.sqlite")).unwrap();
        let before = Settings::default();
        let mut after = before.clone();
        after.notifications = false;
        after.providers.entry(ProviderKind::Codex).or_default().model = Some("m".into());
        note_local_change(&store, &before, &after);
        let notifications = read_recorded(&store, "notifications").expect("a changed shared field is stamped");
        assert_eq!(notifications.value, Value::Bool(false));
        assert!(read_recorded(&store, "providers.codex.model").is_some());
        assert!(read_recorded(&store, "default_provider").is_none(), "an unchanged field is not");
        // A per-machine change leaves no stamp.
        let mut own = after.clone();
        own.background.session_idle_minutes += 1;
        note_local_change(&store, &after, &own);
        assert!(read_recorded(&store, "background").is_none());
        // Stamps only grow, even when the clock is behind a stamp that was seen.
        let far = SettingsStamp { at: Utc::now() + chrono::Duration::hours(1), lamport: 50, machine_id: "x".into() };
        {
            let _held = registers();
            observe_locked(&store, &far);
        }
        let next = next_stamp(&store);
        assert!(next > far, "{next:?} must outrank {far:?}");
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_view_marks_a_field_mixed_only_when_the_machines_that_answered_differ() {
        let machine = |id: &str, state| SettingsMachineView { id: id.into(), name: id.into(), is_self: id == "a", state };
        let answer = |model: &str| PeerSettingsGetResult {
            values: BTreeMap::from([("providers.codex.model".to_string(), serde_json::json!(model))]),
            stamps: BTreeMap::new(),
        };
        let view = view_of(
            vec![
                (machine("a", SettingsMachineState::Reported), Some(answer("x"))),
                (machine("b", SettingsMachineState::Reported), Some(answer("y"))),
                (machine("c", SettingsMachineState::Offline), None),
            ],
            &BTreeMap::from([("providers.codex.model".to_string(), vec!["c".to_string()])]),
        );
        let field = view.fields.iter().find(|field| field.path == "providers.codex.model").unwrap();
        assert!(field.mixed);
        assert_eq!(field.pending, vec!["c".to_string()]);
        assert_eq!(field.values[2].value, None, "an offline machine has no value");
        let same = view_of(
            vec![
                (machine("a", SettingsMachineState::Reported), Some(answer("x"))),
                (machine("b", SettingsMachineState::Reported), Some(answer("x"))),
                (machine("c", SettingsMachineState::Offline), None),
            ],
            &BTreeMap::new(),
        );
        assert!(!same.fields.iter().any(|field| field.mixed), "an offline machine never makes a field Mixed");
    }
}

#[cfg(test)]
mod state_tests {
    use super::*;
    use serde_json::json;

    /// File-backed settings with an in-memory database: the process-global
    /// secret-store handle may outlive this fixture and must not hold its files open.
    fn lone() -> (AppState, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!("kybern-share-state-{}", uuid::Uuid::now_v7()));
        let paths = crate::config::Paths::resolve(Some(root.clone())).unwrap();
        (AppState::initialize_in_memory(&paths).unwrap(), root)
    }

    fn patch(stamp: &SettingsStamp, fields: &[(&str, Value)]) -> SettingsPatch {
        SettingsPatch { stamp: stamp.clone(), fields: fields.iter().map(|(path, value)| ((*path).to_string(), value.clone())).collect() }
    }

    #[tokio::test]
    async fn a_stale_queued_patch_does_not_win_over_a_change_made_here() {
        let (state, root) = lone();
        let queued_at = next_stamp(&state.store);
        // The user changes the field on this machine after the patch was made elsewhere.
        let mut settings = state.settings.get();
        settings.worktrees_default = true;
        state.settings.set(settings).unwrap();
        let result = apply_patch(&state, patch(&queued_at, &[("worktrees_default", json!(false))]));
        assert_eq!(result.stale, vec!["worktrees_default".to_string()], "{result:?}");
        assert!(result.applied.is_empty());
        assert!(state.settings.get().worktrees_default, "the newer local change stays");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn a_newer_patch_applies_once_and_keeps_its_own_stamp() {
        let (state, root) = lone();
        let mut settings = state.settings.get();
        settings.notifications = false;
        state.settings.set(settings).unwrap();
        let newer = next_stamp(&state.store);
        let applied = apply_patch(&state, patch(&newer, &[("notifications", json!(true)), ("providers.codex.model", json!("gpt-x"))]));
        assert_eq!(applied.applied, vec!["notifications".to_string(), "providers.codex.model".to_string()], "{applied:?}");
        let now = state.settings.get();
        assert!(now.notifications);
        assert_eq!(now.providers[&ProviderKind::Codex].model.as_deref(), Some("gpt-x"));
        // The write did not restamp the fields as a local change: they carry the patch's stamp.
        assert_eq!(read_recorded(&state.store, "notifications").unwrap().stamp, newer);
        // The same patch again changes nothing, and an older one is stale.
        let again = apply_patch(&state, patch(&newer, &[("notifications", json!(true))]));
        assert_eq!(again.unchanged, vec!["notifications".to_string()]);
        let older = SettingsStamp { lamport: newer.lamport - 1, at: newer.at - chrono::Duration::seconds(5), ..newer.clone() };
        let stale = apply_patch(&state, patch(&older, &[("notifications", json!(false))]));
        assert_eq!(stale.stale, vec!["notifications".to_string()]);
        assert!(state.settings.get().notifications);
        // A later change made here outranks the patch that was applied.
        let mut settings = state.settings.get();
        settings.notifications = false;
        state.settings.set(settings).unwrap();
        assert!(read_recorded(&state.store, "notifications").unwrap().stamp > newer);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn a_patch_never_reaches_a_per_machine_field() {
        let (state, root) = lone();
        let before = state.settings.get();
        let stamp = next_stamp(&state.store);
        let fields = [
            ("providers.codex.env", json!({"OPENAI_API_KEY": "x"})),
            ("providers.codex.binary", json!("/tmp/evil")),
            ("access", json!({"tailscale": true})),
            ("network", json!({"enabled": false, "port": 1})),
            ("background", json!({})),
            ("computer_use", json!({"enabled": true})),
            ("preview_allowed_folders", json!(["/"])),
        ];
        let result = apply_patch(&state, patch(&stamp, &fields));
        assert_eq!(result.refused.len(), fields.len(), "{result:?}");
        assert!(result.applied.is_empty());
        assert_eq!(state.settings.get(), before);
        // And the shared view never carries them.
        let view = peer_get(&state);
        assert!(view.values.keys().all(|path| shared_paths().contains(path)));
        assert!(!serde_json::to_string(&view).unwrap().contains("OPENAI"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn a_value_the_settings_would_not_save_is_refused_and_leaves_no_stamp() {
        let (state, root) = lone();
        let stamp = next_stamp(&state.store);
        let too_many = serde_json::to_value(OrchestrationSettings { max_active_children: 99, ..Default::default() }).unwrap();
        let result = apply_patch(&state, patch(&stamp, &[("orchestration", too_many), ("generate_titles", json!(false))]));
        assert!(result.applied.is_empty(), "{result:?}");
        assert_eq!(result.refused.len(), 2, "the whole patch was refused: {result:?}");
        assert!(result.refused["orchestration"].contains("between"), "{result:?}");
        assert!(state.settings.get().generate_titles, "nothing changed");
        assert!(read_recorded(&state.store, "generate_titles").is_none(), "no stamp for a change that did not happen");
        // A wrong type is refused field by field; the good field still applies.
        let result =
            apply_patch(&state, patch(&next_stamp(&state.store), &[("notifications", json!("yes")), ("generate_titles", json!(false))]));
        assert_eq!(result.applied, vec!["generate_titles".to_string()], "{result:?}");
        assert!(result.refused.contains_key("notifications"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn sharing_with_no_network_changes_only_this_machine() {
        let (state, root) = lone();
        let result =
            share(&state, SettingsShareParams { fields: [("default_permission_mode".to_string(), json!("auto"))].into(), machines: None })
                .await
                .unwrap();
        assert_eq!(result.here.applied, vec!["default_permission_mode".to_string()]);
        assert!(result.machines.is_empty());
        assert_eq!(state.settings.get().default_permission_mode, PermissionMode::Auto);
        // A path that is not shared is refused before anything changes.
        let refused =
            share(&state, SettingsShareParams { fields: [("access".to_string(), json!({}))].into(), machines: None }).await.unwrap_err();
        assert!(refused.message.contains("not a shared setting"), "{}", refused.message);
        let view = network_view(&state).await;
        assert_eq!(view.machines.len(), 1);
        assert!(view.fields.iter().all(|field| !field.mixed));
        std::fs::remove_dir_all(root).unwrap();
    }
}
