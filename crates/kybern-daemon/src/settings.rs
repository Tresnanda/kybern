//! settings.json: loaded at startup, replaced atomically on update.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, RwLock};

use anyhow::{Context, Result};
use kybern_protocol::Settings;
use kybern_store::Store;

#[derive(Clone)]
pub struct SettingsStore {
    path: PathBuf,
    current: Arc<RwLock<Settings>>,
    /// Held for each whole write, so writes never interleave and [`SettingsStore::update`] reads what it replaces.
    writer: Arc<Mutex<()>>,
    changed: tokio::sync::broadcast::Sender<Settings>,
    /// Where the stamps of shared-field changes are kept once the daemon attaches its store (S1).
    stamps: Arc<OnceLock<Store>>,
}

impl SettingsStore {
    pub fn load(path: &Path) -> Result<Self> {
        let settings = match std::fs::read_to_string(path) {
            Ok(text) => serde_json::from_str(&text).with_context(|| format!("parse {}", path.display()))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let s = Settings::default();
                write_atomic(path, &s)?;
                s
            }
            Err(e) => return Err(e.into()),
        };
        crate::provider_assets::prepare_existing(&settings);
        Ok(Self {
            path: path.to_path_buf(),
            current: Arc::new(RwLock::new(settings)),
            writer: Arc::new(Mutex::new(())),
            changed: tokio::sync::broadcast::channel(32).0,
            stamps: Arc::new(OnceLock::new()),
        })
    }

    /// Stamp every later change of a shared field in `store` (see `settings_share`).
    pub fn attach_stamps(&self, store: Store) {
        let _ = self.stamps.set(store);
    }

    /// The data directory `settings.json` lives in.
    pub fn dir(&self) -> &Path {
        self.path.parent().unwrap_or(Path::new("."))
    }

    pub fn get(&self) -> Settings {
        self.current.read().unwrap().clone()
    }

    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<Settings> {
        self.changed.subscribe()
    }

    pub fn set(&self, settings: Settings) -> Result<Settings> {
        let _writer = self.writer.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        self.write(settings, AccountChoice::Shared)
    }

    /// Change the current settings in place: `change` sees what is saved at that moment, and no other write
    /// lands between that read and this write. `None` from `change` writes nothing. A background writer uses
    /// this so it never overwrites an edit made since it last read the settings.
    pub fn update<T>(&self, change: impl FnOnce(&Settings) -> Option<(Settings, T)>) -> Result<Option<(Settings, T)>> {
        self.update_with(|settings, _| Ok(change(settings)))
    }

    /// [`SettingsStore::update`] for a change that can fail, and that says how its own change of this machine's
    /// default or project accounts reaches the shared values (`AccountChoice`, `Shared` unless `change` says).
    pub fn update_with<T>(
        &self,
        change: impl FnOnce(&Settings, &mut AccountChoice) -> Result<Option<(Settings, T)>>,
    ) -> Result<Option<(Settings, T)>> {
        let _writer = self.writer.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut choice = AccountChoice::Shared;
        let Some((next, out)) = change(&self.get(), &mut choice)? else { return Ok(None) };
        Ok(Some((self.write(next, choice)?, out)))
    }

    /// Save a whole document a client sent, against the `base` it was edited from (#378). Account fields the
    /// client left as they were in `base` keep their current value, so a default, name or account that arrived
    /// from another machine (or another writer) since the client read the settings is never undone. Without a
    /// `base` (an older client) the document is saved as sent.
    pub fn replace(&self, client: Settings, base: Option<&Settings>) -> Result<Settings> {
        let _writer = self.writer.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let next = match base {
            Some(base) => merge_account_fields(&self.get(), base, client),
            None => client,
        };
        self.write(next, AccountChoice::Shared)
    }

    fn write(&self, mut settings: Settings, choice: AccountChoice) -> Result<Settings> {
        // A credential a client just typed goes into the secret store; settings keep the reference.
        crate::secret_store::externalize(&mut settings)?;
        validate_orchestration(&settings.orchestration)?;
        settings.compaction.validate().map_err(anyhow::Error::msg)?;
        for (kind, servers) in &settings.coordinator_mcp_servers {
            anyhow::ensure!(
                matches!(
                    kind,
                    kybern_protocol::ProviderKind::ClaudeCode
                        | kybern_protocol::ProviderKind::Opencode
                        | kybern_protocol::ProviderKind::Pi
                        | kybern_protocol::ProviderKind::Omp
                ),
                "This harness cannot restrict Coordinator tools. Choose Claude Code, OpenCode, Pi or OMP."
            );
            anyhow::ensure!(
                servers.len() <= 128
                    && servers.iter().all(|name| kybern_drivers::coordinator_mcp::valid_server_name(name) && name != "kybern"),
                "Choose valid MCP server names without wildcards and save again."
            );
        }
        if let Some(omp) = settings.providers.get(&kybern_protocol::ProviderKind::Omp) {
            for profile in omp.env.get("OMP_PROFILE").into_iter().chain(omp.project_profiles.values()) {
                kybern_drivers::omp_profile::normalize(profile)?;
            }
        }
        // Shared accounts and this machine's own account fields follow each other (`accounts_shared`).
        {
            let before = self.current.read().unwrap().clone();
            let store = self.stamps.get();
            let terminal = crate::accounts_shared::terminal_emails(store);
            let repos = crate::accounts_shared::project_repo_keys(store);
            crate::accounts_shared::normalize_with(&before, &mut settings, &terminal, &repos, choice);
        }
        crate::accounts_shared::validate(&settings.accounts_shared)?;
        crate::provider_accounts::validate(&settings)?;
        let _cache_guard = crate::network::list_cache::CACHE_LOCK.lock().unwrap();
        let before = self.current.read().unwrap().clone();
        write_atomic(&self.path, &settings)?;
        *self.current.write().unwrap() = settings.clone();
        if let Some(store) = self.stamps.get() {
            crate::settings_share::note_local_change(store, &before, &settings);
            if !settings.network.keep_network_data {
                store.meta_delete_prefix("network.list_cache.")?;
            }
        }
        crate::secret_store::collect_garbage(&settings);
        let _ = self.changed.send(settings.clone());
        Ok(settings)
    }
}

/// How a write's own change of this machine's default or project accounts reaches `accounts_shared`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum AccountChoice {
    /// Chosen on this machine by a route that only knows the local fields (an older client, the CLI): every
    /// machine follows it.
    #[default]
    Shared,
    /// A change nobody made for the whole network (a machine's first sign-in, removing the default account):
    /// it stays on this machine, and the shared default and project choices stay as they are.
    LocalOnly,
}

/// `client` with its account fields three-way merged against `base` and `current`: an entry the client
/// changed relative to `base` is the client's, any other is `current`'s. The fields are the shared account
/// values (`accounts_shared`: each default, profile, project and offer answer) and each harness's accounts,
/// default account and project accounts. Everything else is the client's, as before.
pub fn merge_account_fields(current: &Settings, base: &Settings, mut client: Settings) -> Settings {
    use std::collections::{BTreeMap, BTreeSet};
    fn merge_map<K: Ord + Clone, V: PartialEq + Clone>(
        current: &BTreeMap<K, V>,
        base: &BTreeMap<K, V>,
        client: &BTreeMap<K, V>,
    ) -> BTreeMap<K, V> {
        let keys: BTreeSet<&K> = current.keys().chain(base.keys()).chain(client.keys()).collect();
        keys.into_iter()
            .filter_map(|key| {
                let theirs = client.get(key);
                let chosen = if theirs != base.get(key) { theirs } else { current.get(key) };
                chosen.map(|value| (key.clone(), value.clone()))
            })
            .collect()
    }
    let shared = &mut client.accounts_shared;
    shared.defaults = merge_map(&current.accounts_shared.defaults, &base.accounts_shared.defaults, &shared.defaults);
    shared.profiles = merge_map(&current.accounts_shared.profiles, &base.accounts_shared.profiles, &shared.profiles);
    shared.projects = merge_map(&current.accounts_shared.projects, &base.accounts_shared.projects, &shared.projects);
    shared.offers = merge_map(&current.accounts_shared.offers, &base.accounts_shared.offers, &shared.offers);
    let kinds: BTreeSet<kybern_protocol::ProviderKind> =
        current.providers.keys().chain(base.providers.keys()).chain(client.providers.keys()).copied().collect();
    let empty = kybern_protocol::ProviderSettings::default();
    for kind in kinds {
        let now = current.providers.get(&kind).unwrap_or(&empty);
        let was = base.providers.get(&kind).unwrap_or(&empty);
        let mut theirs = client.providers.get(&kind).cloned().unwrap_or_else(|| now.clone());
        let accounts = merge_map(&now.accounts, &was.accounts, &theirs.accounts);
        let projects = merge_map(&now.project_accounts, &was.project_accounts, &theirs.project_accounts);
        let default =
            if theirs.default_account != was.default_account { theirs.default_account.clone() } else { now.default_account.clone() };
        if accounts == theirs.accounts && projects == theirs.project_accounts && default == theirs.default_account {
            continue;
        }
        theirs.accounts = accounts;
        theirs.project_accounts = projects;
        theirs.default_account = default;
        client.providers.insert(kind, theirs);
    }
    client
}

/// Delegation limits must stay in the ranges the settings screen offers.
fn validate_orchestration(orchestration: &kybern_protocol::OrchestrationSettings) -> Result<()> {
    anyhow::ensure!(
        (1..=16).contains(&orchestration.max_active_children),
        "Active agents per thread must be between 1 and 16. Change the value and save again."
    );
    anyhow::ensure!(
        (1..=16).contains(&orchestration.lead_max_children),
        "Active agents per Coordinator must be between 1 and 16. Change the value and save again."
    );
    anyhow::ensure!(
        (1..=4).contains(&orchestration.max_depth),
        "Delegation depth must be between 1 and 4. Change the value and save again."
    );
    orchestration.validate_coordinator().map_err(anyhow::Error::msg)?;
    Ok(())
}

fn write_atomic(path: &Path, settings: &Settings) -> Result<()> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(settings)?)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Profile overrides use the registered project, never a temporary worktree cwd.
/// Supply the effective OMP environment to discovery, imports and process spawn.
pub fn provider_settings(
    settings: &Settings,
    kind: kybern_protocol::ProviderKind,
    project_path: Option<&str>,
) -> kybern_protocol::ProviderSettings {
    let mut provider = settings.providers.get(&kind).cloned().unwrap_or_default();
    if kind == kybern_protocol::ProviderKind::Omp
        && let Some(profile) = project_path.and_then(|path| provider.project_profiles.get(path))
    {
        provider.env.insert("OMP_PROFILE".into(), profile.trim().into());
    }
    let instance = crate::provider_accounts::resolve(&provider, project_path, None);
    // Settings are validated before persistence. Legacy defaults stay unchanged.
    if let Ok(env) = crate::provider_accounts::environment(&provider, kind, &instance) {
        provider.env = env;
    }
    provider
}

#[cfg(test)]
mod orchestration_tests {
    use super::*;

    #[test]
    fn orchestration_limits_are_range_checked_on_update() {
        let dir = std::env::temp_dir().join(format!("kybern-settings-test-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = SettingsStore::load(&dir.join("settings.json")).unwrap();
        let mut settings = store.get();
        for (children, depth) in [(0, 2), (17, 2), (4, 0), (4, 5)] {
            settings.orchestration.max_active_children = children;
            settings.orchestration.max_depth = depth;
            let error = store.set(settings.clone()).unwrap_err().to_string();
            assert!(error.contains("between"), "{error}");
        }
        settings.orchestration.max_active_children = 4;
        settings.orchestration.max_depth = 2;
        for lead in [0, 17] {
            settings.orchestration.lead_max_children = lead;
            let error = store.set(settings.clone()).unwrap_err().to_string();
            assert!(error.contains("Coordinator must be between 1 and 16"), "{error}");
        }
        settings.orchestration.lead_max_children = 6;
        assert_eq!(store.get().orchestration, kybern_protocol::OrchestrationSettings::default(), "rejected updates change nothing");
        settings.orchestration.max_active_children = 16;
        settings.orchestration.max_depth = 4;
        settings.orchestration.lead_max_children = 16;
        let saved = store.set(settings).unwrap().orchestration;
        assert_eq!((saved.max_active_children, saved.lead_max_children), (16, 16));
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[cfg(test)]
mod profile_tests {
    use super::*;
    use kybern_protocol::ProviderKind;

    #[test]
    fn project_profile_overrides_global_env_including_explicit_default() {
        let mut settings = Settings::default();
        let omp = settings.providers.entry(ProviderKind::Omp).or_default();
        omp.env.insert("OMP_PROFILE".into(), "global".into());
        omp.env.insert("PI_PROFILE".into(), "legacy".into());
        omp.project_profiles.insert("/projects/work".into(), "work".into());
        omp.project_profiles.insert("/projects/default".into(), "".into());
        assert_eq!(provider_settings(&settings, ProviderKind::Omp, Some("/projects/work")).env["OMP_PROFILE"], "work");
        assert_eq!(provider_settings(&settings, ProviderKind::Omp, Some("/projects/default")).env["OMP_PROFILE"], "");
        assert_eq!(provider_settings(&settings, ProviderKind::Omp, Some("/projects/else")).env["OMP_PROFILE"], "global");
        assert_eq!(provider_settings(&settings, ProviderKind::Omp, None).env["OMP_PROFILE"], "global");
        assert!(provider_settings(&settings, ProviderKind::Pi, Some("/projects/work")).env.is_empty());
    }

    #[test]
    fn coordinator_mcp_defaults_off_round_trips_and_rejects_globs() {
        let dir = std::env::temp_dir().join(format!("kybern-mcp-settings-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        let store = SettingsStore::load(&path).unwrap();
        let mut settings = store.get();
        assert!(settings.coordinator_mcp_servers.is_empty());
        settings.coordinator_mcp_servers.insert(kybern_protocol::ProviderKind::Omp, vec!["memory".into()]);
        store.set(settings.clone()).unwrap();
        assert_eq!(SettingsStore::load(&path).unwrap().get().coordinator_mcp_servers, settings.coordinator_mcp_servers);
        settings.coordinator_mcp_servers.insert(kybern_protocol::ProviderKind::Omp, vec!["*".into()]);
        assert!(store.set(settings).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[cfg(test)]
mod replace_tests {
    use super::*;
    use kybern_protocol::{AccountProfile, ProviderAccount, ProviderKind};

    fn account(name: &str, email: &str, dir: &Path) -> ProviderAccount {
        ProviderAccount {
            name: name.into(),
            directory: dir.join(name).to_string_lossy().into_owned(),
            color: Some("blue".into()),
            email: Some(email.into()),
            plan: None,
        }
    }

    /// #378: a client that read the settings, then saved its whole document after a sync (or another writer)
    /// changed the accounts, keeps what arrived meanwhile and changes only what it changed.
    #[test]
    fn a_whole_document_save_never_undoes_accounts_that_arrived_meanwhile() {
        let dir = std::env::temp_dir().join(format!("kybern-settings-replace-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = SettingsStore::load(&dir.join("settings.json")).unwrap();
        let mut settings = store.get();
        let claude = settings.providers.entry(ProviderKind::ClaudeCode).or_default();
        claude.accounts.insert("w1".into(), account("Work", "work@example.com", &dir));
        claude.accounts.insert("p1".into(), account("Personal", "me@home.org", &dir));
        claude.default_account = Some("p1".into());
        store.set(settings).unwrap();
        // The client reads the settings...
        let base = store.get();
        assert_eq!(base.accounts_shared.defaults[&ProviderKind::ClaudeCode], "claude-code:me@home.org");
        // ...meanwhile another machine's sync makes Work the default and renames it, and a sign-in adds an account.
        store
            .update(|current| {
                let mut next = current.clone();
                next.accounts_shared.defaults.insert(ProviderKind::ClaudeCode, "claude-code:work@example.com".into());
                next.accounts_shared.profiles.insert(
                    "claude-code:work@example.com".into(),
                    AccountProfile { name: "Office".into(), color: Some("blue".into()), manual_only: false },
                );
                next.providers
                    .get_mut(&ProviderKind::ClaudeCode)
                    .unwrap()
                    .accounts
                    .insert("n1".into(), account("New", "new@example.com", &dir));
                Some((next, ()))
            })
            .unwrap();
        assert_eq!(store.get().providers[&ProviderKind::ClaudeCode].default_account.as_deref(), Some("w1"));
        // ...and the client saves an unrelated change with the whole document it read.
        let mut client = base.clone();
        client.generate_titles = !base.generate_titles;
        let saved = store.replace(client.clone(), Some(&base)).unwrap();
        assert_eq!(saved.generate_titles, client.generate_titles, "the client's own change lands");
        assert_eq!(saved.accounts_shared.defaults[&ProviderKind::ClaudeCode], "claude-code:work@example.com", "the synced default stays");
        assert_eq!(saved.accounts_shared.profiles["claude-code:work@example.com"].name, "Office");
        let claude = &saved.providers[&ProviderKind::ClaudeCode];
        assert_eq!(claude.default_account.as_deref(), Some("w1"));
        assert_eq!(claude.accounts["w1"].name, "Office");
        assert!(claude.accounts.contains_key("n1"), "an account added meanwhile stays");

        // What the client did change is the client's: here, Personal is the default again and New is removed.
        let base = store.get();
        let mut client = base.clone();
        client.accounts_shared.defaults.insert(ProviderKind::ClaudeCode, "claude-code:me@home.org".into());
        client.providers.get_mut(&ProviderKind::ClaudeCode).unwrap().accounts.remove("n1");
        let saved = store.replace(client, Some(&base)).unwrap();
        assert_eq!(saved.providers[&ProviderKind::ClaudeCode].default_account.as_deref(), Some("p1"));
        assert!(!saved.providers[&ProviderKind::ClaudeCode].accounts.contains_key("n1"));

        // Without a base (an older client) the document is saved as sent, as before.
        let stale = base.clone();
        let saved = store.replace(stale, None).unwrap();
        assert!(saved.providers[&ProviderKind::ClaudeCode].accounts.contains_key("n1"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
