//! Accounts across machines (`Settings.accounts_shared`).
//!
//! * **Keys.** An account is one identity across machines, keyed `<kind>:<email>` lowercase. Storage stays
//!   per machine: a key maps to this machine's own login by email ([`instance_for_key`]); a named account's
//!   email is the one its last probe saw (`ProviderAccount::email`), the terminal login's is kept in `meta`
//!   ([`remember_terminal_email`]).
//! * **Projection.** `defaults` and `projects` feed the account `resolve` order through this machine's own
//!   `default_account` and `project_accounts`, and `profiles` give the local accounts their name and colour.
//!   [`normalize`] runs on every settings write and keeps the two in step in both directions: a change of
//!   the local fields (an older client, the CLI, a finished sign-in) moves the shared value, and a change of
//!   the shared value (a sync from another machine) moves the local fields. Every caller of `resolve` keeps
//!   working unchanged.
//! * **Migration.** [`migrate`] builds the shared values from this machine's accounts once, on the first
//!   run with shared accounts. It keeps what another machine already shared and records this machine's own
//!   defaults from before, so a default that changed is listed once as a clash (`accounts.offers`).

use std::collections::BTreeMap;

use anyhow::{Result, ensure};
use kybern_protocol::methods::AccountsListParams;
use kybern_protocol::{AccountProfile, AccountsShared, ProjectKind, ProviderKind, Settings};
use kybern_store::Store;

use crate::state::AppState;

const TERMINAL_EMAIL: &str = "accounts.terminal_email.";
/// Set once the first-run migration ran on this machine.
pub const MIGRATED: &str = "accounts.shared.migrated";
/// This machine's own defaults from before the migration, by harness: the source of clash offers.
pub const PREMIGRATION: &str = "accounts.shared.premigration";

pub const MAX_PROFILES: usize = 256;
pub const MAX_PROJECTS: usize = 512;
pub const MAX_OFFERS: usize = 256;

/// Harnesses whose logins have an email, so an account is the same one on every machine.
pub fn has_identity(kind: ProviderKind) -> bool {
    matches!(kind, ProviderKind::ClaudeCode | ProviderKind::Codex | ProviderKind::Cursor | ProviderKind::Antigravity)
}

/// `<kind>:<email>`, lowercase.
pub fn key(kind: ProviderKind, email: &str) -> String {
    format!("{}:{}", kind.as_str(), email.trim().to_ascii_lowercase())
}

/// The harness and email of a key.
pub fn parse_key(key: &str) -> Option<(ProviderKind, &str)> {
    let (kind, email) = key.split_once(':')?;
    let kind: ProviderKind = kind.parse().ok()?;
    (has_identity(kind) && email.contains('@') && email.len() <= 254 && email == email.trim() && !email.chars().any(char::is_uppercase))
        .then_some((kind, email))
}

/// The email the terminal login of `kind` had when it was last probed.
pub fn terminal_email(store: &Store, kind: ProviderKind) -> Option<String> {
    store.meta_get(&format!("{TERMINAL_EMAIL}{}", kind.as_str())).ok().flatten().filter(|email| !email.is_empty())
}

/// Remember the terminal login's email. Returns whether it changed.
pub fn remember_terminal_email(store: &Store, kind: ProviderKind, email: Option<&str>) -> bool {
    let email = email.map(|email| email.trim().to_ascii_lowercase()).unwrap_or_default();
    if terminal_email(store, kind).unwrap_or_default() == email {
        return false;
    }
    store.meta_set(&format!("{TERMINAL_EMAIL}{}", kind.as_str()), &email).is_ok()
}

/// The emails this machine knows for the terminal logins, by harness.
pub type TerminalEmails = BTreeMap<ProviderKind, String>;

pub fn terminal_emails(store: Option<&Store>) -> TerminalEmails {
    let Some(store) = store else { return TerminalEmails::new() };
    ProviderKind::ALL.into_iter().filter(|kind| has_identity(*kind)).filter_map(|kind| Some((kind, terminal_email(store, kind)?))).collect()
}

/// The key of one of this machine's accounts (`default` is the terminal login), when its email is known.
pub fn key_of_instance(settings: &Settings, terminal: &TerminalEmails, kind: ProviderKind, instance: &str) -> Option<String> {
    if !has_identity(kind) {
        return None;
    }
    let email = if instance == "default" {
        terminal.get(&kind).cloned()
    } else {
        settings.providers.get(&kind)?.accounts.get(instance)?.email.clone()
    }?;
    Some(key(kind, &email))
}

/// This machine's login for a key: a named account with that email, else the terminal login when it has it.
/// Named accounts come first, so Kybern stays out of the user's shell login when it can.
pub fn instance_for_key(settings: &Settings, terminal: &TerminalEmails, key_text: &str) -> Option<String> {
    let (kind, email) = parse_key(key_text)?;
    let named = settings.providers.get(&kind).and_then(|provider| {
        provider
            .accounts
            .iter()
            .find(|(_, account)| account.email.as_deref().is_some_and(|known| known.trim().eq_ignore_ascii_case(email)))
            .map(|(id, _)| id.clone())
    });
    named.or_else(|| terminal.get(&kind).filter(|known| known.eq_ignore_ascii_case(email)).map(|_| "default".to_string()))
}

/// Registered project paths and the repository key each one has (`RepoIdentity::key`). Group projects are
/// left out: they have no one repository.
pub fn project_repo_keys(store: Option<&Store>) -> BTreeMap<String, String> {
    let Some(store) = store else { return BTreeMap::new() };
    store
        .projects_list()
        .unwrap_or_default()
        .into_iter()
        .filter(|project| project.kind != ProjectKind::Group)
        .filter_map(|project| Some((project.path, project.repo.as_ref()?.key()?)))
        .collect()
}

/// Whether the shared values fit: valid keys, names and colours, bounded sizes.
pub fn validate(shared: &AccountsShared) -> Result<()> {
    ensure!(
        shared.profiles.len() <= MAX_PROFILES && shared.projects.len() <= MAX_PROJECTS && shared.offers.len() <= MAX_OFFERS,
        "There are too many shared accounts, projects or offers. Remove some and save again."
    );
    for (key_text, profile) in &shared.profiles {
        ensure!(parse_key(key_text).is_some(), "{key_text} is not an account key. Use <harness>:<email> in lowercase.");
        ensure!(!profile.name.trim().is_empty() && profile.name.len() <= 120, "Enter an account name up to 120 characters.");
        if let Some(color) = &profile.color {
            crate::provider_accounts::validate_color(color)?;
        }
    }
    for (kind, key_text) in &shared.defaults {
        ensure!(
            parse_key(key_text).is_some_and(|(of, _)| of == *kind),
            "The default {} account must be a {} account key.",
            kind.display_name(),
            kind.display_name()
        );
    }
    for (repo, kinds) in &shared.projects {
        ensure!(!repo.is_empty() && repo.len() <= 300, "A project's repository identity is missing or too long.");
        for (kind, key_text) in kinds {
            ensure!(
                parse_key(key_text).is_some_and(|(of, _)| of == *kind),
                "A project's {} account must be a {} account key.",
                kind.display_name(),
                kind.display_name()
            );
        }
    }
    for (id, dismissal) in &shared.offers {
        ensure!(!id.is_empty() && id.len() <= 200 && dismissal.fingerprint.len() <= 128, "An offer id or fingerprint is too long.");
    }
    Ok(())
}

fn local_default(settings: &Settings, kind: ProviderKind) -> String {
    settings
        .providers
        .get(&kind)
        .map(|provider| crate::provider_accounts::resolve(provider, None, None))
        .unwrap_or_else(|| "default".into())
}

/// Keep the shared account values and this machine's own account fields in step (see the module docs).
/// `before` is what was saved, `after` what is about to be saved; `after` is changed in place.
pub fn normalize(before: &Settings, after: &mut Settings, terminal: &TerminalEmails, repos: &BTreeMap<String, String>) {
    for kind in ProviderKind::ALL.into_iter().filter(|kind| has_identity(*kind)) {
        normalize_default(before, after, terminal, kind);
        normalize_projects(before, after, terminal, repos, kind);
        normalize_profiles(before, after, kind);
    }
}

fn normalize_default(before: &Settings, after: &mut Settings, terminal: &TerminalEmails, kind: ProviderKind) {
    let shared_changed = before.accounts_shared.defaults.get(&kind) != after.accounts_shared.defaults.get(&kind);
    let local_changed = local_default(before, kind) != local_default(after, kind);
    if local_changed && !shared_changed {
        // Chosen on this machine by a route that only knows the local fields.
        match key_of_instance(after, terminal, kind, &local_default(after, kind)) {
            Some(key_text) => {
                after.accounts_shared.defaults.insert(kind, key_text);
            }
            // An account whose email is not known yet: other machines can't follow it, and keeping the old
            // shared default would undo this choice on the next write.
            None => {
                after.accounts_shared.defaults.remove(&kind);
            }
        }
        return;
    }
    let Some(key_text) = after.accounts_shared.defaults.get(&kind).cloned() else { return };
    // A default whose account isn't on this machine leaves the machine's own choice in place.
    if let Some(instance) = instance_for_key(after, terminal, &key_text)
        && local_default(after, kind) != instance
    {
        after.providers.entry(kind).or_default().default_account = (instance != "default").then_some(instance);
    }
}

fn normalize_projects(
    before: &Settings,
    after: &mut Settings,
    terminal: &TerminalEmails,
    repos: &BTreeMap<String, String>,
    kind: ProviderKind,
) {
    let empty = BTreeMap::new();
    let local_before = before.providers.get(&kind).map_or(&empty, |provider| &provider.project_accounts).clone();
    let local_after = after.providers.get(&kind).map_or(&empty, |provider| &provider.project_accounts).clone();
    let shared_of =
        |settings: &Settings, repo: &str| settings.accounts_shared.projects.get(repo).and_then(|kinds| kinds.get(&kind)).cloned();
    // Local changes first: a project chosen or cleared here.
    let mut touched = std::collections::BTreeSet::new();
    for path in local_before.keys().chain(local_after.keys()) {
        if local_before.get(path) == local_after.get(path) {
            continue;
        }
        let Some(repo) = repos.get(path) else { continue };
        if shared_of(before, repo) != shared_of(after, repo) {
            continue;
        }
        touched.insert(repo.clone());
        let next = local_after.get(path).and_then(|instance| key_of_instance(after, terminal, kind, instance));
        let kinds = after.accounts_shared.projects.entry(repo.clone()).or_default();
        match next {
            Some(key_text) => {
                kinds.insert(kind, key_text);
            }
            None => {
                kinds.remove(&kind);
            }
        }
        if kinds.is_empty() {
            after.accounts_shared.projects.remove(repo);
        }
    }
    // Then the shared choices, onto every checkout of the repository here.
    let mut local = local_after;
    for (path, repo) in repos {
        if touched.contains(repo) {
            continue;
        }
        match shared_of(after, repo) {
            Some(key_text) => {
                if let Some(instance) = instance_for_key(after, terminal, &key_text) {
                    local.insert(path.clone(), instance);
                }
            }
            None => {
                // Cleared on another machine: drop the local choice that followed it.
                if let Some(old) = shared_of(before, repo)
                    && local.get(path).is_some_and(|instance| instance_for_key(before, terminal, &old).as_deref() == Some(instance))
                {
                    local.remove(path);
                }
            }
        }
    }
    if after.providers.get(&kind).map_or(&empty, |provider| &provider.project_accounts) != &local {
        after.providers.entry(kind).or_default().project_accounts = local;
    }
}

fn normalize_profiles(before: &Settings, after: &mut Settings, kind: ProviderKind) {
    let Some(provider) = after.providers.get(&kind) else { return };
    let ids: Vec<String> = provider.accounts.keys().cloned().collect();
    for id in ids {
        let Some(account) = after.providers.get(&kind).and_then(|provider| provider.accounts.get(&id)).cloned() else { continue };
        let Some(email) = account.email.as_deref() else { continue };
        let key_text = key(kind, email);
        let old = before.providers.get(&kind).and_then(|provider| provider.accounts.get(&id));
        let profile_changed = before.accounts_shared.profiles.get(&key_text) != after.accounts_shared.profiles.get(&key_text);
        let renamed = old.is_some_and(|old| old.name != account.name || old.color != account.color);
        match after.accounts_shared.profiles.get(&key_text).cloned() {
            // Renamed or recoloured here: every machine follows.
            Some(mut profile) if renamed && !profile_changed => {
                profile.name = account.name.clone();
                if account.color.is_some() {
                    profile.color = account.color.clone();
                }
                after.accounts_shared.profiles.insert(key_text, profile);
            }
            // The shared look wins over this machine's copy.
            Some(profile) => {
                if let Some(local) = after.providers.get_mut(&kind).and_then(|provider| provider.accounts.get_mut(&id))
                    && (local.name != profile.name || (profile.color.is_some() && local.color != profile.color))
                {
                    local.name = profile.name.clone();
                    if profile.color.is_some() {
                        local.color = profile.color.clone();
                    }
                }
            }
            // An account the network did not know: it brings its look.
            None if after.accounts_shared.profiles.len() < MAX_PROFILES => {
                after
                    .accounts_shared
                    .profiles
                    .insert(key_text, AccountProfile { name: account.name.clone(), color: account.color.clone(), manual_only: false });
            }
            None => {}
        }
    }
}

/// Build the shared values from this machine's accounts, once. Probes the terminal logins first, so they
/// can merge with the account that has their email (the probe never redeems a Claude refresh token, #107).
/// Values another machine already shared are kept; a default that differs from this machine's own is
/// recorded in [`PREMIGRATION`] and shown as a clash.
pub async fn migrate(state: &AppState) -> Result<()> {
    if state.store.meta_get(MIGRATED)?.is_some() {
        return Ok(());
    }
    // Learning the terminal logins' emails (and the named accounts' emails, through write-back).
    let _ = crate::provider_accounts::list(state, AccountsListParams { kind: None, refresh: false }).await;
    let terminal = terminal_emails(Some(&state.store));
    let settings = state.settings.get();
    let mut next = settings.clone();
    let mut premigration: BTreeMap<ProviderKind, String> = BTreeMap::new();
    for kind in ProviderKind::ALL.into_iter().filter(|kind| has_identity(*kind)) {
        if let Some(key_text) = key_of_instance(&settings, &terminal, kind, &local_default(&settings, kind)) {
            premigration.insert(kind, key_text.clone());
            next.accounts_shared.defaults.entry(kind).or_insert(key_text);
        }
        let Some(provider) = settings.providers.get(&kind) else { continue };
        for account in provider.accounts.values() {
            let Some(email) = account.email.as_deref() else { continue };
            if next.accounts_shared.profiles.len() >= MAX_PROFILES {
                break;
            }
            next.accounts_shared.profiles.entry(key(kind, email)).or_insert_with(|| AccountProfile {
                name: account.name.clone(),
                color: account.color.clone(),
                manual_only: false,
            });
        }
    }
    let repos = project_repo_keys(Some(&state.store));
    for kind in ProviderKind::ALL.into_iter().filter(|kind| has_identity(*kind)) {
        let Some(provider) = settings.providers.get(&kind) else { continue };
        for (path, instance) in &provider.project_accounts {
            let (Some(repo), Some(key_text)) = (repos.get(path), key_of_instance(&settings, &terminal, kind, instance)) else { continue };
            if next.accounts_shared.projects.len() >= MAX_PROJECTS && !next.accounts_shared.projects.contains_key(repo) {
                continue;
            }
            next.accounts_shared.projects.entry(repo.clone()).or_default().entry(kind).or_insert(key_text);
        }
    }
    if next != settings {
        state.settings.set(next)?;
    }
    state.store.meta_set(PREMIGRATION, &serde_json::to_string(&premigration)?)?;
    state.store.meta_set(MIGRATED, &chrono::Utc::now().to_rfc3339())?;
    Ok(())
}

/// Wait after start, so the migration's probes never compete with the daemon's startup work.
const STARTUP_DELAY: std::time::Duration = std::time::Duration::from_secs(8);
/// How often this machine's holdings are read again when no client asks for the account list.
const HOLDINGS_EVERY: std::time::Duration = std::time::Duration::from_secs(30 * 60);

/// The background worker: the migration once, then this machine's holdings (published by every full
/// account list) every [`HOLDINGS_EVERY`]. Identity probes are cached and never redeem a Claude refresh
/// token (#107).
pub async fn run(state: AppState) {
    tokio::select! {
        _ = state.shutdown.cancelled() => return,
        _ = tokio::time::sleep(STARTUP_DELAY) => {}
    }
    if let Err(error) = migrate(&state).await {
        tracing::warn!(%error, "could not merge this machine's accounts into the shared ones");
    }
    loop {
        let _ = crate::provider_accounts::list(&state, AccountsListParams { kind: None, refresh: false }).await;
        tokio::select! {
            _ = state.shutdown.cancelled() => return,
            _ = tokio::time::sleep(HOLDINGS_EVERY) => {}
        }
    }
}

/// This machine's defaults from before the migration.
pub fn premigration(store: &Store) -> BTreeMap<ProviderKind, String> {
    store.meta_get(PREMIGRATION).ok().flatten().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use kybern_protocol::{ProviderAccount, ProviderSettings};

    fn account(name: &str, email: Option<&str>) -> ProviderAccount {
        ProviderAccount {
            name: name.into(),
            directory: std::env::temp_dir().join(name).to_string_lossy().into_owned(),
            color: Some("blue".into()),
            email: email.map(Into::into),
            plan: None,
        }
    }

    fn settings_with(accounts: &[(&str, &str, Option<&str>)]) -> Settings {
        let mut settings = Settings::default();
        let provider: &mut ProviderSettings = settings.providers.entry(ProviderKind::ClaudeCode).or_default();
        for (id, name, email) in accounts {
            provider.accounts.insert((*id).into(), account(name, *email));
        }
        settings
    }

    #[test]
    fn keys_are_lowercase_and_parse_back() {
        assert_eq!(key(ProviderKind::ClaudeCode, " Me@Example.COM "), "claude-code:me@example.com");
        assert_eq!(parse_key("codex:me@example.com"), Some((ProviderKind::Codex, "me@example.com")));
        assert_eq!(parse_key("codex:Me@example.com"), None);
        assert_eq!(parse_key("omp:me@example.com"), None, "omp has no identity");
        assert_eq!(parse_key("claude-code:nobody"), None);
    }

    #[test]
    fn a_key_maps_to_the_local_account_with_that_email_named_first() {
        let settings = settings_with(&[("work", "Work", Some("Work@Example.com")), ("home", "Home", Some("me@home.org"))]);
        let mut terminal = TerminalEmails::new();
        terminal.insert(ProviderKind::ClaudeCode, "me@home.org".into());
        assert_eq!(instance_for_key(&settings, &terminal, "claude-code:work@example.com").as_deref(), Some("work"));
        // The terminal login has the same email as a named account: the named one runs.
        assert_eq!(instance_for_key(&settings, &terminal, "claude-code:me@home.org").as_deref(), Some("home"));
        terminal.insert(ProviderKind::ClaudeCode, "solo@shell.dev".into());
        assert_eq!(instance_for_key(&settings, &terminal, "claude-code:solo@shell.dev").as_deref(), Some("default"));
        assert_eq!(instance_for_key(&settings, &terminal, "claude-code:else@where.com"), None);
        assert_eq!(
            key_of_instance(&settings, &terminal, ProviderKind::ClaudeCode, "work").as_deref(),
            Some("claude-code:work@example.com")
        );
        assert_eq!(
            key_of_instance(&settings, &terminal, ProviderKind::ClaudeCode, "default").as_deref(),
            Some("claude-code:solo@shell.dev")
        );
    }

    #[test]
    fn a_shared_default_lands_on_the_local_account_and_a_local_choice_moves_the_shared_one() {
        let terminal = TerminalEmails::new();
        let repos = BTreeMap::new();
        let before = settings_with(&[("w1", "Work", Some("work@example.com")), ("p1", "Personal", Some("me@home.org"))]);
        // From another machine: Work is the default.
        let mut after = before.clone();
        after.accounts_shared.defaults.insert(ProviderKind::ClaudeCode, "claude-code:work@example.com".into());
        normalize(&before, &mut after, &terminal, &repos);
        assert_eq!(after.providers[&ProviderKind::ClaudeCode].default_account.as_deref(), Some("w1"));
        // Chosen here by an older client: Personal.
        let saved = after.clone();
        let mut next = saved.clone();
        next.providers.get_mut(&ProviderKind::ClaudeCode).unwrap().default_account = Some("p1".into());
        normalize(&saved, &mut next, &terminal, &repos);
        assert_eq!(next.accounts_shared.defaults[&ProviderKind::ClaudeCode], "claude-code:me@home.org");
        // A default for an account this machine lacks leaves its own choice.
        let saved = next.clone();
        let mut next = saved.clone();
        next.accounts_shared.defaults.insert(ProviderKind::ClaudeCode, "claude-code:else@where.com".into());
        normalize(&saved, &mut next, &terminal, &repos);
        assert_eq!(next.providers[&ProviderKind::ClaudeCode].default_account.as_deref(), Some("p1"));
    }

    #[test]
    fn project_choices_follow_the_repository() {
        let terminal = TerminalEmails::new();
        let repos: BTreeMap<String, String> = [("/here/app".to_string(), "root:abc".to_string())].into();
        let before = settings_with(&[("w1", "Work", Some("work@example.com"))]);
        let mut after = before.clone();
        after
            .accounts_shared
            .projects
            .entry("root:abc".into())
            .or_default()
            .insert(ProviderKind::ClaudeCode, "claude-code:work@example.com".into());
        normalize(&before, &mut after, &terminal, &repos);
        assert_eq!(after.providers[&ProviderKind::ClaudeCode].project_accounts["/here/app"], "w1");
        // Cleared here: cleared for every machine.
        let saved = after.clone();
        let mut next = saved.clone();
        next.providers.get_mut(&ProviderKind::ClaudeCode).unwrap().project_accounts.clear();
        normalize(&saved, &mut next, &terminal, &repos);
        assert!(next.accounts_shared.projects.is_empty());
        // Cleared elsewhere: the local copy goes too.
        let mut next = after.clone();
        next.accounts_shared.projects.clear();
        normalize(&after, &mut next, &terminal, &repos);
        assert!(next.providers[&ProviderKind::ClaudeCode].project_accounts.is_empty());
    }

    #[test]
    fn profiles_give_every_machine_the_same_name_and_colour() {
        let (terminal, repos) = (TerminalEmails::new(), BTreeMap::new());
        let before = settings_with(&[]);
        let mut after = settings_with(&[("w1", "Work", Some("work@example.com"))]);
        normalize(&before, &mut after, &terminal, &repos);
        assert_eq!(after.accounts_shared.profiles["claude-code:work@example.com"].name, "Work");
        // Renamed on another machine.
        let saved = after.clone();
        let mut next = saved.clone();
        next.accounts_shared.profiles.get_mut("claude-code:work@example.com").unwrap().name = "Job".into();
        normalize(&saved, &mut next, &terminal, &repos);
        assert_eq!(next.providers[&ProviderKind::ClaudeCode].accounts["w1"].name, "Job");
        // Renamed here.
        let saved = next.clone();
        let mut next = saved.clone();
        next.providers.get_mut(&ProviderKind::ClaudeCode).unwrap().accounts.get_mut("w1").unwrap().name = "Office".into();
        normalize(&saved, &mut next, &terminal, &repos);
        assert_eq!(next.accounts_shared.profiles["claude-code:work@example.com"].name, "Office");
    }

    #[test]
    fn validation_refuses_bad_keys_and_mismatched_kinds() {
        let mut shared = AccountsShared::default();
        shared.defaults.insert(ProviderKind::Codex, "claude-code:me@example.com".into());
        assert!(validate(&shared).is_err());
        shared.defaults.insert(ProviderKind::Codex, "codex:me@example.com".into());
        assert!(validate(&shared).is_ok());
        shared.profiles.insert("codex:ME@example.com".into(), AccountProfile { name: "Me".into(), ..Default::default() });
        assert!(validate(&shared).is_err());
    }
}
